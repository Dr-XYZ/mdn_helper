const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const matter = require('gray-matter');

// --- 設定 ---
const CONTENT_REPO = './mdn-content';
const TRANS_REPO = './mdn-translated-content';
const TARGET_LOCALE = 'zh-tw';
const OUTPUT_DIR = './public';
const PR_DATA_PATH = './prs.json';

// --- 輔助函式: 檢查檔案是否存在於某個 Commit ---
function checkFileExists(cwd, commitHash, filePath) {
    return new Promise((resolve) => {
        const child = spawn('git', ['cat-file', '-e', `${commitHash}:${filePath}`], { cwd });
        child.on('close', (code) => resolve(code === 0));
    });
}

// --- 輔助函式: 使用 --follow 找出舊檔名 ---
function findRenamedSource(cwd, fromHash, toHash, currentFilePath) {
    return new Promise((resolve) => {
        const args = [
            'log', '--follow', '--name-only', '--format=',
            `${fromHash}..${toHash}`, '--', currentFilePath
        ];
        
        const child = spawn('git', args, { cwd });
        let data = '';
        child.stdout.on('data', chunk => data += chunk);
        child.on('close', () => {
            const lines = data.trim().split('\n').filter(line => line.trim() !== '');
            resolve(lines.length > 0 ? lines[lines.length - 1].trim() : null);
        });
        child.on('error', () => resolve(null));
    });
}

// --- Git Diff (支援 Rename + Word Diff) ---
async function getGitDiff(cwd, fromHash, toHash, filePath) {
    let oldPath = filePath;
    
    // 1. 檢查舊版是否存在 (處理改名)
    const existsAtOld = await checkFileExists(cwd, fromHash, filePath);
    if (!existsAtOld) {
        const detectedOldPath = await findRenamedSource(cwd, fromHash, toHash, filePath);
        if (detectedOldPath) oldPath = detectedOldPath;
    }

    return new Promise((resolve) => {
        // 2. 使用 Word Diff 模式比對 Blob
        const args = [
            'diff', 
            '--word-diff=plain', // 使用 plain 模式
            '--no-color',
            `${fromHash}:${oldPath}`, 
            `${toHash}:${filePath}`
        ];
        
        const child = spawn('git', args, { cwd });
        let data = '';
        
        child.stdout.on('data', chunk => data += chunk);
        child.stderr.on('data', () => {}); 
        child.on('close', () => {
            if (data.length > 50000) { 
                data = data.substring(0, 50000) + '\n... (差異過大，已截斷) ...';
            }
            resolve(data || ''); // 若無差異回傳空字串
        });
        child.on('error', () => resolve('Error generating diff'));
    });
}

// --- 讀取 PR 資料 (從本地 JSON) ---

async function loadPRsFromFile() {
    const prMap = new Map();
    
    if (!await fs.pathExists(PR_DATA_PATH)) {
        console.log('⚠️ 找不到 prs.json，跳過 PR 標記。');
        return prMap;
    }

    try {
        const rawData = await fs.readJson(PR_DATA_PATH);
        
        // 適應 search (GraphQL) 的結構
        let prList = [];
        if (rawData.data?.search?.nodes) {
            prList = rawData.data.search.nodes;
        } else if (rawData.data?.repository?.pullRequests?.nodes) {
            prList = rawData.data.repository.pullRequests.nodes;
        }

        console.log(`[PR] 原始 API 回傳 ${prList.length} 筆 (包含 zh-cn 與 zh-tw)`);

        let matchCount = 0;
        // 設定過濾前綴，例如 "files/zh-tw/"
        const prefix = `files/${TARGET_LOCALE.toLowerCase()}/`; 

        for (const pr of prList) {
            // 過濾無效資料
            if (!pr.files || !pr.files.nodes) continue;

            const files = pr.files.nodes;
            
            for (const file of files) {
                const rawPath = file.path;
                
                // ★★★ 關鍵過濾 ★★★
                // 只接受路徑開頭是 files/zh-tw/ 的檔案
                // 這樣就能自動過濾掉 files/zh-cn/ 的 PR
                if (rawPath.toLowerCase().startsWith(prefix)) {
                    
                    // 移除前綴，取得相對路徑 (例如 index.md)
                    // substring 效能比 replace 好，且我們已經確認過 startsWith
                    const relativePath = rawPath.substring(prefix.length);
                    
                    prMap.set(relativePath, {
                        url: pr.url,
                        number: pr.number,
                        title: pr.title,
                        user: pr.author?.login || 'unknown'
                    });
                    matchCount++;
                }
            }
        }
        
        console.log(`[PR] 篩選完成: 共 ${prMap.size} 個 ${TARGET_LOCALE} 檔案被標記 (剔除簡中與無關檔案)`);
        
        // Debug: 印出前 3 筆確認路徑正確
        if (prMap.size > 0) {
             console.log('[PR Debug] 範例:', Array.from(prMap.keys()).slice(0, 3));
        }

    } catch (e) {
        console.error('❌ 解析 prs.json 失敗:', e.message);
    }
    
    return prMap;
}

async function run() {
    console.time('執行時間');
    
    // 1. 載入 PR 資料
    const prMap = await loadPRsFromFile();

    console.log(`[1/4] 開始比對... 目標語言: ${TARGET_LOCALE}`);

    // 2. 建立英文版索引
    const latestCommits = new Map();
    const gitLogProcess = spawn('git', ['log', '--format=::: %H', '--name-only', 'files/en-us'], { cwd: CONTENT_REPO });

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

    // 3. 比對與生成資料
    const report = [];
    const processingPromises = [];

    for (const [srcFilePath, currentHash] of latestCommits) {
        if (!srcFilePath.endsWith('.md')) continue;

        processingPromises.push((async () => {
            const relativePath = srcFilePath.replace('files/en-us/', '');
            const transFilePath = path.join(TRANS_REPO, 'files', TARGET_LOCALE, relativePath);
            const fullSrcPath = path.join(CONTENT_REPO, srcFilePath);
            
            const prInfo = prMap.get(relativePath) || null;

            // 取得完整檔案大小 (用於 Untranslated 狀態)
            let fullFileSize = 0;
            try {
                const stats = await fs.stat(fullSrcPath);
                fullFileSize = stats.size;
            } catch (e) { fullFileSize = 0; }

            const item = {
                path: relativePath,
                size: 0, // 稍後計算
                status: 'untranslated',
                pr: prInfo,
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
                        // ★ 最新：工作量為 0
                        item.status = 'up_to_date';
                        item.content = transContent;
                        item.size = 0;
                    } else {
                        // ★ 過期：工作量為 Diff 大小
                        item.status = 'outdated';
                        item.content = transContent;
                        item.diff = await getGitDiff(CONTENT_REPO, item.sourceCommit, item.currentCommit, srcFilePath);
                        // 如果 diff 失敗或為空，size 為 0，否則為字串長度
                        item.size = item.diff ? item.diff.length : 0;
                    }
                } else {
                    // ★ 缺 Meta：視同未翻譯，工作量為全檔
                    item.status = 'missing_meta';
                    item.content = await fs.readFile(fullSrcPath, 'utf8');
                    item.size = fullFileSize;
                }
            } catch (err) {
                // ★ 未翻譯：工作量為全檔
                item.status = 'untranslated';
                try {
                    item.content = await fs.readFile(fullSrcPath, 'utf8');
                } catch (e) {
                    item.content = '(無法讀取英文原文)';
                }
                item.size = fullFileSize;
            }
            return item;
        })());
    }

    const results = await Promise.all(processingPromises);
    report.push(...results);

    // 4. 輸出檔案
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