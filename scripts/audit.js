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
            // 限制 30KB，避免 JSON 過大
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

    // 1. 建立英文版索引 (Stream)
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
                content: null, // 用於 Prompt
                url: `https://developer.mozilla.org/${TARGET_LOCALE}/docs/${relativePath.replace('.md', '').replace('/index', '')}`
            };

            try {
                const fileContent = await fs.readFile(transFilePath, 'utf8');
                const parsed = matter(fileContent);
                const recordedCommit = parsed.data.l10n?.sourceCommit;

                if (recordedCommit) {
                    item.sourceCommit = recordedCommit;
                    if (item.sourceCommit === currentHash) {
                        item.status = 'up_to_date';
                    } else {
                        item.status = 'outdated';
                        // 僅對過期檔案抓取 Diff 與 Content
                        item.diff = await getGitDiff(CONTENT_REPO, item.sourceCommit, item.currentCommit, srcFilePath);
                        item.content = fileContent;
                    }
                } else {
                    item.status = 'missing_meta';
                }
            } catch (err) {
                item.status = 'untranslated';
            }
            return item;
        })());
    }

    const results = await Promise.all(processingPromises);
    report.push(...results);

    // 3. 輸出檔案
    await fs.ensureDir(OUTPUT_DIR);

    // A. 寫入主資料
    await fs.writeFile(path.join(OUTPUT_DIR, 'data.json'), JSON.stringify(report, null, 2));

    // B. 寫入 Prompt 設定檔 (meta.json) - 這是修正關鍵
    let promptContent = "請翻譯:\n\nDiff: {{DIFF}}\n\nContent: {{CONTENT}}";
    if (await fs.pathExists('prompt.txt')) {
        promptContent = await fs.readFile('prompt.txt', 'utf8');
        console.log('已讀取 prompt.txt');
    }
    await fs.writeFile(path.join(OUTPUT_DIR, 'meta.json'), JSON.stringify({ prompt: promptContent }, null, 2));

    // C. 複製網頁模板 (不做任何替換)
    if (await fs.pathExists('template.html')) {
        await fs.copy('template.html', path.join(OUTPUT_DIR, 'index.html'));
    } else {
        console.error('錯誤: 找不到 template.html');
    }

    console.log(`[4/4] 完成！生成 ${report.length} 筆資料。`);
    console.timeEnd('執行時間');
}

run().catch(console.error);