const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const matter = require('gray-matter');

// --- 設定 ---
const CONTENT_REPO = './mdn-content';
const TRANS_REPO = './mdn-translated-content';
const TARGET_LOCALE = 'zh-tw';
const OUTPUT_DIR = './public';

async function run() {
    console.time('執行時間');
    console.log(`開始比對... 目標語言: ${TARGET_LOCALE}`);

    // 1. 快速獲取英文版 Git 歷史
    console.log('正在讀取英文版 Git Log...');
    
    const latestCommits = new Map();
    const gitLogProcess = spawn('git', [
        'log', 
        '--format=::: %H', 
        '--name-only', 
        'files/en-us'
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
                url: `https://developer.mozilla.org/${TARGET_LOCALE}/docs/${relativePath.replace('.md', '').replace('/index', '')}`
            };

            try {
                const content = await fs.readFile(transFilePath, 'utf8');
                const parsed = matter(content);
                
                // --- 修正重點開始 ---
                // 讀取 l10n 屬性下的 sourceCommit
                // 使用 ?. (Optional Chaining) 避免舊檔案沒有 l10n 造成報錯
                const recordedCommit = parsed.data.l10n?.sourceCommit;
                // --- 修正重點結束 ---

                if (recordedCommit) {
                    item.sourceCommit = recordedCommit;
                    item.status = (item.sourceCommit === currentHash) ? 'up_to_date' : 'outdated';
                } else {
                    item.status = 'missing_meta';
                }
            } catch (err) {
                item.status = 'untranslated';
            }
            
            return item;
        })());
    }

    // 3. 並發執行
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