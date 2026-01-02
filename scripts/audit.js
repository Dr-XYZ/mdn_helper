const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const matter = require('gray-matter');

// --- 設定 ---
const CONTENT_REPO = './mdn-content';
const TRANS_REPO = './mdn-translated-content';
const TARGET_LOCALE = 'zh-tw'; // 若要改語言，請改這裡
const OUTPUT_DIR = './public';

async function run() {
    console.time('執行時間');
    console.log(`開始比對... 目標語言: ${TARGET_LOCALE}`);

    // 1. 快速獲取英文版 Git 歷史
    console.log('正在讀取英文版 Git Log...');
    
    const latestCommits = new Map();
    const gitLogProcess = spawn('git', [
        'log', 
        '--format=::: %H',  // 自定義分隔符，方便解析
        '--name-only',      // 只列出檔名
        'files/en-us'       // 只看英文目錄
    ], { cwd: CONTENT_REPO });

    let currentHash = null;
    let lineBuffer = '';

    // 使用 Stream 解析，極省記憶體
    for await (const chunk of gitLogProcess.stdout) {
        lineBuffer += chunk;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop(); 

        for (const line of lines) {
            if (line.startsWith('::: ')) {
                currentHash = line.substring(4).trim();
            } else if (line && currentHash) {
                // 如果這個檔案還沒記錄過，這就是它最新的 Hash
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

    for (const [srcFilePath, currentHash] of latestCommits) {
        // [重要] 過濾非 Markdown 檔案，保持跟原本功能一致
        if (!srcFilePath.endsWith('.md')) continue;

        processingPromises.push((async () => {
            // srcFilePath 範例: files/en-us/web/javascript/index.md
            // 計算相對路徑 (去除 files/en-us/)
            const relativePath = srcFilePath.replace('files/en-us/', '');
            const transFilePath = path.join(TRANS_REPO, 'files', TARGET_LOCALE, relativePath);
            
            const item = {
                path: relativePath,
                status: 'untranslated',
                sourceCommit: null,
                currentCommit: currentHash,
                url: `https://developer.mozilla.org/${TARGET_LOCALE}/docs/${relativePath.replace('.md', '').replace('/index', '')}`
            };

            try {
                // 讀取翻譯檔案
                const content = await fs.readFile(transFilePath, 'utf8');
                const parsed = matter(content);
                
                if (parsed.data.sourceCommit) {
                    item.sourceCommit = parsed.data.sourceCommit;
                    item.status = (item.sourceCommit === currentHash) ? 'up_to_date' : 'outdated';
                } else {
                    item.status = 'missing_meta';
                }
            } catch (err) {
                // 讀取失敗通常代表檔案不存在
                item.status = 'untranslated';
            }
            
            return item;
        })());
    }

    // 3. 並發執行比對
    const results = await Promise.all(processingPromises);
    report.push(...results);

    // 4. 輸出結果
    await fs.ensureDir(OUTPUT_DIR);
    await fs.writeFile(path.join(OUTPUT_DIR, 'data.json'), JSON.stringify(report, null, 2));
    
    // 複製網頁模板
    if (fs.existsSync('template.html')) {
        await fs.copy('template.html', path.join(OUTPUT_DIR, 'index.html'));
    } else {
        console.warn('警告: 找不到 template.html，網頁可能無法顯示。');
    }

    console.log(`處理完成，共生成 ${report.length} 筆資料。`);
    console.timeEnd('執行時間');
}

run().catch(console.error);