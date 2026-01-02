const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const matter = require('gray-matter');

// --- 設定 ---
const CONTENT_REPO = './mdn-content';
const TRANS_REPO = './mdn-translated-content';
const TARGET_LOCALE = 'zh-tw';
const OUTPUT_DIR = './public';

// [新增] 執行 Git Diff 的輔助函式
function getGitDiff(cwd, fromHash, toHash, filePath) {
    return new Promise((resolve) => {
        // 指令: git diff oldHash...newHash -- files/en-us/path/to/file.md
        const args = ['diff', `${fromHash}...${toHash}`, '--', filePath];
        const child = spawn('git', args, { cwd });
        
        let data = '';
        child.stdout.on('data', chunk => data += chunk);
        child.stderr.on('data', () => {}); // 忽略錯誤輸出
        
        child.on('close', () => {
            // 如果 diff 太大 (超過 20KB)，截斷它以免 JSON 爆掉
            if (data.length > 20000) {
                data = data.substring(0, 20000) + '\n... (差異過大，僅顯示前 20KB) ...';
            }
            resolve(data);
        });
        
        child.on('error', () => resolve('')); // 發生錯誤回傳空字串
    });
}

async function run() {
    console.time('執行時間');
    console.log(`開始比對... 目標語言: ${TARGET_LOCALE}`);

    // 1. 快速獲取英文版 Git 歷史
    console.log('正在讀取英文版 Git Log...');
    
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
            } else if (line && currentHash) {
                if (!latestCommits.has(line)) {
                    latestCommits.set(line, currentHash);
                }
            }
        }
    }

    console.log(`索引建立完成，共發現 ${latestCommits.size} 個檔案。`);

    // 2. 準備比對列表
    const report = [];
    const processingPromises = [];

    // 為了避免 git spawn 過多導致系統崩潰，我們使用簡單的隊列控制 (Chunking)
    // 但為了代碼簡單，這裡用一般的 Promise.all，若檔案非常多(數萬)，建議分批處理
    const entries = Array.from(latestCommits.entries());
    
    for (const [srcFilePath, currentHash] of entries) {
        if (!srcFilePath.endsWith('.md')) continue;

        processingPromises.push((async () => {
            const relativePath = srcFilePath.replace('files/en-us/', '');
            const transFilePath = path.join(TRANS_REPO, 'files', TARGET_LOCALE, relativePath);
            
            const item = {
                path: relativePath,
                status: 'untranslated',
                sourceCommit: null,
                currentCommit: currentHash,
                diff: null, // [新增] 存放 Diff 內容
                url: `https://developer.mozilla.org/${TARGET_LOCALE}/docs/${relativePath.replace('.md', '').replace('/index', '')}`
            };

            try {
                const content = await fs.readFile(transFilePath, 'utf8');
                const parsed = matter(content);
                const recordedCommit = parsed.data.l10n?.sourceCommit;

                if (recordedCommit) {
                    item.sourceCommit = recordedCommit;
                    if (item.sourceCommit === currentHash) {
                        item.status = 'up_to_date';
                    } else {
                        item.status = 'outdated';
                        // [新增] 如果過期，抓取 Diff
                        // 注意：傳入的是 mdn-content 內的完整路徑 (srcFilePath)
                        item.diff = await getGitDiff(CONTENT_REPO, item.sourceCommit, item.currentCommit, srcFilePath);
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

    // 4. 輸出
    await fs.ensureDir(OUTPUT_DIR);
    await fs.writeFile(path.join(OUTPUT_DIR, 'data.json'), JSON.stringify(report, null, 2));
    
    if (fs.existsSync('template.html')) {
        await fs.copy('template.html', path.join(OUTPUT_DIR, 'index.html'));
    }

    console.log(`處理完成，共生成 ${report.length} 筆資料。`);
    console.timeEnd('執行時間');
}

run().catch(console.error);