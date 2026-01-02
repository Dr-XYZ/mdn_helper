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
            // 英文原文的完整路徑 (用於未翻譯時讀取)
            const fullSrcPath = path.join(CONTENT_REPO, srcFilePath);
            
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
                // 嘗試讀取翻譯檔案
                const transContent = await fs.readFile(transFilePath, 'utf8');
                const parsed = matter(transContent);
                const recordedCommit = parsed.data.l10n?.sourceCommit;

                if (recordedCommit) {
                    item.sourceCommit = recordedCommit;
                    
                    if (item.sourceCommit === currentHash) {
                        // 情況 1: 最新版本
                        item.status = 'up_to_date';
                        item.content = transContent; // 顯示中文
                    } else {
                        // 情況 2: 需要更新
                        item.status = 'outdated';
                        item.content = transContent; // 顯示中文 (讓 AI 參考舊翻譯)
                        item.diff = await getGitDiff(CONTENT_REPO, item.sourceCommit, item.currentCommit, srcFilePath);
                    }
                } else {
                    // 情況 3: 缺少 Meta (可能是壞掉的翻譯，或格式錯誤)
                    item.status = 'missing_meta';
                    // [修改] 讀取英文原文，方便重翻
                    item.content = await fs.readFile(fullSrcPath, 'utf8');
                }
            } catch (err) {
                // 情況 4: 檔案不存在 (未翻譯)
                item.status = 'untranslated';
                
                // [修改] 讀取英文原文
                try {
                    item.content = await fs.readFile(fullSrcPath, 'utf8');
                } catch (e) {
                    item.content = '(無法讀取英文原文)';
                }
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