const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const matter = require('gray-matter');

// --- 設定 ---
const CONTENT_REPO = './mdn-content';
const TRANS_REPO = './mdn-translated-content';
const TARGET_LOCALE = 'zh-tw'; // 若要改語言，請改這裡
const OUTPUT_DIR = './public';

// 輔助：執行 Git Diff
function getGitDiff(cwd, fromHash, toHash, filePath) {
    return new Promise((resolve) => {
        // 指令: git diff old...new -- file.md
        const args = ['diff', `${fromHash}...${toHash}`, '--', filePath];
        const child = spawn('git', args, { cwd });
        
        let data = '';
        child.stdout.on('data', chunk => data += chunk);
        child.stderr.on('data', () => {}); // 忽略錯誤
        
        child.on('close', () => {
            // 限制 Diff 大小以免 JSON 爆掉 (20KB)
            if (data.length > 20000) {
                data = data.substring(0, 20000) + '\n... (差異過大，僅顯示前 20KB) ...';
            }
            resolve(data);
        });
        
        child.on('error', () => resolve(''));
    });
}

async function run() {
    console.time('執行時間');
    console.log(`開始比對... 目標語言: ${TARGET_LOCALE}`);

    // 1. 快速獲取英文版 Git 歷史 (Stream Parsing)
    console.log('正在讀取英文版 Git Log...');
    
    const latestCommits = new Map();
    const gitLogProcess = spawn('git', [
        'log', 
        '--format=::: %H',  // 自定義分隔符
        '--name-only',      // 只列出檔名
        'files/en-us'       // 只看英文目錄
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
        // 只處理 Markdown
        if (!srcFilePath.endsWith('.md')) continue;

        processingPromises.push((async () => {
            // srcFilePath: files/en-us/web/javascript/index.md
            const relativePath = srcFilePath.replace('files/en-us/', '');
            const transFilePath = path.join(TRANS_REPO, 'files', TARGET_LOCALE, relativePath);
            
            const item = {
                path: relativePath,
                status: 'untranslated',
                sourceCommit: null,
                currentCommit: currentHash,
                diff: null,     // 存放 Git Diff
                content: null,  // 存放翻譯全文 (供 Prompt 使用)
                url: `https://developer.mozilla.org/${TARGET_LOCALE}/docs/${relativePath.replace('.md', '').replace('/index', '')}`
            };

            try {
                // 讀取翻譯檔案
                const fileContent = await fs.readFile(transFilePath, 'utf8');
                const parsed = matter(fileContent);
                
                // 讀取 l10n 區塊
                const recordedCommit = parsed.data.l10n?.sourceCommit;

                if (recordedCommit) {
                    item.sourceCommit = recordedCommit;
                    
                    if (item.sourceCommit === currentHash) {
                        item.status = 'up_to_date';
                    } else {
                        item.status = 'outdated';
                        // 若過期：抓取 Diff 並儲存全文
                        item.diff = await getGitDiff(CONTENT_REPO, item.sourceCommit, item.currentCommit, srcFilePath);
                        item.content = fileContent; 
                    }
                } else {
                    item.status = 'missing_meta';
                }
            } catch (err) {
                // 檔案不存在
                item.status = 'untranslated';
            }
            
            return item;
        })());
    }

    // 3. 並發執行
    const results = await Promise.all(processingPromises);
    report.push(...results);

    // 4. 輸出結果與注入 Prompt
    await fs.ensureDir(OUTPUT_DIR);
    await fs.writeFile(path.join(OUTPUT_DIR, 'data.json'), JSON.stringify(report, null, 2));
    
    if (fs.existsSync('template.html')) {
        let template = await fs.readFile('template.html', 'utf8');
        let promptContent = '';

        // 讀取 prompt.txt
        if (fs.existsSync('prompt.txt')) {
            promptContent = await fs.readFile('prompt.txt', 'utf8');
            console.log('已讀取 prompt.txt');
        }

        // 注入 Prompt 到 HTML 變數中
        template = template.replace(
            '// __INJECT_PROMPT__', 
            `const injectedPrompt = ${JSON.stringify(promptContent)};`
        );

        await fs.writeFile(path.join(OUTPUT_DIR, 'index.html'), template);
    } else {
        console.warn('警告: 找不到 template.html');
    }

    console.log(`處理完成，共生成 ${report.length} 筆資料。`);
    console.timeEnd('執行時間');
}

run().catch(console.error);