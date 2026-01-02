const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const matter = require('gray-matter');

// --- 設定 ---
const CONTENT_REPO = './mdn-content';
const TRANS_REPO = './mdn-translated-content';
const TARGET_LOCALE = 'zh-tw';
const OUTPUT_DIR = './public';

// Git Diff 輔助函式
function getGitDiff(cwd, fromHash, toHash, filePath) {
    return new Promise((resolve) => {
        const args = ['diff', `${fromHash}...${toHash}`, '--', filePath];
        const child = spawn('git', args, { cwd });
        let data = '';
        child.stdout.on('data', chunk => data += chunk);
        child.stderr.on('data', () => {}); 
        child.on('close', () => {
            if (data.length > 30000) {
                data = data.substring(0, 30000) + '\n... (差異過大，已截斷) ...';
            }
            resolve(data);
        });
        child.on('error', () => resolve(''));
    });
}

async function run() {
    console.time('執行時間');
    console.log(`[1/4] 開始比對... 目標語言: ${TARGET_LOCALE}`);

    // 1. 建立英文版索引
    const latestCommits = new Map();
    const gitLogProcess = spawn('git', [
        'log', '--format=::: %H', '--name-only', 'files/en-us'
    ], { cwd: CONTENT_REPO });

    let currentHash = null;
    let lineBuffer = '';

    for await (const chunk of gitLogProcess.stdout) {
        lineBuffer += chunk;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop(); 
        for (const line of lines) {
            if (line.startsWith('::: ')) {
                currentHash = line.substring(4).trim();
            } else if (line && currentHash && !latestCommits.has(line)) {
                latestCommits.set(line, currentHash);
            }
        }
    }
    console.log(`[2/4] 索引建立完成，共 ${latestCommits.size} 個檔案。`);

    // 2. 比對與生成資料
    const report = [];
    const processingPromises = [];

    for (const [srcFilePath, currentHash] of latestCommits) {
        if (!srcFilePath.endsWith('.md')) continue;

        processingPromises.push((async () => {
            const relativePath = srcFilePath.replace('files/en-us/', '');
            const transFilePath = path.join(TRANS_REPO, 'files', TARGET_LOCALE, relativePath);
            
            const item = {
                path: relativePath,
                status: 'untranslated',
                sourceCommit: null,
                currentCommit: currentHash,
                diff: null,
                content: null, 
                url: `https://developer.mozilla.org/${TARGET_LOCALE}/docs/${relativePath.replace('.md', '').replace('/index', '')}`
            };

            try {
                // [修改] 無論狀態如何，只要檔案存在就讀取內容
                const fileContent = await fs.readFile(transFilePath, 'utf8');
                item.content = fileContent; // 存入全文

                const parsed = matter(fileContent);
                const recordedCommit = parsed.data.l10n?.sourceCommit;

                if (recordedCommit) {
                    item.sourceCommit = recordedCommit;
                    if (item.sourceCommit === currentHash) {
                        item.status = 'up_to_date';
                        // 最新版本通常沒有 Diff
                    } else {
                        item.status = 'outdated';
                        // 只有過期才抓 Diff
                        item.diff = await getGitDiff(CONTENT_REPO, item.sourceCommit, item.currentCommit, srcFilePath);
                    }
                } else {
                    item.status = 'missing_meta';
                }
            } catch (err) {
                // 檔案不存在 (Untranslated)
                item.status = 'untranslated';
            }
            return item;
        })());
    }

    const results = await Promise.all(processingPromises);
    report.push(...results);

    // 3. 輸出檔案
    await fs.ensureDir(OUTPUT_DIR);
    await fs.writeFile(path.join(OUTPUT_DIR, 'data.json'), JSON.stringify(report, null, 2));

    let promptContent = "請翻譯:\n\nDiff: {{DIFF}}\n\nContent: {{CONTENT}}";
    if (await fs.pathExists('prompt.txt')) {
        promptContent = await fs.readFile('prompt.txt', 'utf8');
    }
    await fs.writeFile(path.join(OUTPUT_DIR, 'meta.json'), JSON.stringify({ prompt: promptContent }, null, 2));

    if (await fs.pathExists('template.html')) {
        await fs.copy('template.html', path.join(OUTPUT_DIR, 'index.html'));
    }

    console.log(`[4/4] 完成！生成 ${report.length} 筆資料。`);
    console.timeEnd('執行時間');
}

run().catch(console.error);