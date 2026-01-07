const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const matter = require('gray-matter');

// --- 設定 ---
const CONTENT_REPO = './mdn-content';
const TRANS_REPO = './mdn-translated-content';
const TARGET_LOCALE = 'zh-tw';
const OUTPUT_DIR = './public';

// --- 新增輔助函式: 檢查檔案是否存在於某個 Commit ---
function checkFileExists(cwd, commitHash, filePath) {
    return new Promise((resolve) => {
        // git cat-file -e 檢查物件是否存在，回傳 0 代表存在
        const child = spawn('git', ['cat-file', '-e', `${commitHash}:${filePath}`], { cwd });
        child.on('close', (code) => {
            resolve(code === 0);
        });
    });
}

// --- 新增輔助函式: 使用 --follow 找出舊檔名 ---
function findRenamedSource(cwd, fromHash, toHash, currentFilePath) {
    return new Promise((resolve) => {
        // 使用 git log --follow 列出該檔案的歷史路徑
        // 取最後一行 (最舊的紀錄) 即為該區間開始時的檔名
        const args = [
            'log',
            '--follow',
            '--name-only',
            '--format=', // 不輸出 commit 資訊，只留檔名
            `${fromHash}..${toHash}`,
            '--',
            currentFilePath
        ];
        
        const child = spawn('git', args, { cwd });
        let data = '';
        child.stdout.on('data', chunk => data += chunk);
        child.on('close', () => {
            const lines = data.trim().split('\n').filter(line => line.trim() !== '');
            if (lines.length > 0) {
                // 取最後一行 (時間軸上最接近 fromHash 的檔名)
                resolve(lines[lines.length - 1].trim());
            } else {
                resolve(null);
            }
        });
        child.on('error', () => resolve(null));
    });
}

// --- 修改後的 Git Diff ---
async function getGitDiff(cwd, fromHash, toHash, filePath) {
    // 1. 先判斷在舊的 Commit 中，該路徑是否存在
    let oldPath = filePath;
    const existsAtOld = await checkFileExists(cwd, fromHash, filePath);

    if (!existsAtOld) {
        // 2. 如果舊 Commit 沒這個檔名，嘗試偵測是否為改名 (Rename)
        // console.log(`偵測到檔案可能已更名: ${filePath}`);
        const detectedOldPath = await findRenamedSource(cwd, fromHash, toHash, filePath);
        
        if (detectedOldPath) {
            oldPath = detectedOldPath;
            // console.log(`  -> 追蹤到舊檔名為: ${oldPath}`);
        } else {
            // 真的找不到 (可能是全新檔案)，保持原樣，Diff 會顯示全綠新增
        }
    }

    // 3. 使用 <commit>:<path> 語法進行精準比對
    // 這樣即使檔名不同，Git 也能比較內容差異
    return new Promise((resolve) => {
        const args = ['diff', `${fromHash}:${oldPath}`, `${toHash}:${filePath}`];
        const child = spawn('git', args, { cwd });
        let data = '';
        
        child.stdout.on('data', chunk => data += chunk);
        child.stderr.on('data', () => {}); 
        
        child.on('close', () => {
            if (data.length > 30000) {
                data = data.substring(0, 30000) + '\n... (差異過大，已截斷) ...';
            }
            // 如果比對失敗(例如舊檔真的不存在)，通常會沒輸出或報錯，這裡回傳空字串或 data
            resolve(data || '(無差異或全新檔案)');
        });
        
        child.on('error', () => resolve('Error generating diff'));
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
                const transContent = await fs.readFile(transFilePath, 'utf8');
                const parsed = matter(transContent);
                const recordedCommit = parsed.data.l10n?.sourceCommit;

                if (recordedCommit) {
                    item.sourceCommit = recordedCommit;
                    
                    if (item.sourceCommit === currentHash) {
                        item.status = 'up_to_date';
                        item.content = transContent;
                    } else {
                        item.status = 'outdated';
                        item.content = transContent;
                        // [重要] 這裡呼叫改進後的 getGitDiff
                        item.diff = await getGitDiff(CONTENT_REPO, item.sourceCommit, item.currentCommit, srcFilePath);
                    }
                } else {
                    item.status = 'missing_meta';
                    item.content = await fs.readFile(fullSrcPath, 'utf8');
                }
            } catch (err) {
                item.status = 'untranslated';
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
