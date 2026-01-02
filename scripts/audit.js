const fs = require('fs-extra');
const path = require('path');
const { glob } = require('glob');
const matter = require('gray-matter');
const simpleGit = require('simple-git');

// --- 設定 ---
const CONTENT_REPO_PATH = './mdn-content'; // 英文源 Repo
const TRANSLATED_REPO_PATH = './mdn-translated-content'; // 翻譯 Repo
const TARGET_LOCALE = 'zh-tw'; // 目標語言，例如 zh-tw, ja, es
const OUTPUT_DIR = './public';

async function getLatestCommitHash(repoPath, filePath) {
  const git = simpleGit(repoPath);
  try {
    // 獲取該檔案最後一次變更的完整 Hash
    const log = await git.log({ file: filePath, maxCount: 1 });
    return log.latest ? log.latest.hash : null;
  } catch (e) {
    return null;
  }
}

async function run() {
  console.log(`開始比對... 目標語言: ${TARGET_LOCALE}`);
  
  // 1. 獲取所有英文源文件
  // MDN content 結構通常是 files/en-us/**/*.md
  const srcPattern = path.join(CONTENT_REPO_PATH, 'files', 'en-us', '**', '*.md');
  const srcFiles = await glob(srcPattern);
  
  const report = [];

  for (const srcFileFull of srcFiles) {
    // 計算相對路徑，例如：glossary/index.md
    const relativePath = path.relative(path.join(CONTENT_REPO_PATH, 'files', 'en-us'), srcFileFull);
    
    // 計算對應的翻譯檔案路徑
    const translatedFileFull = path.join(TRANSLATED_REPO_PATH, 'files', TARGET_LOCALE, relativePath);
    
    const item = {
      path: relativePath,
      status: '', // 1:Up-to-date, 2:Outdated, 3:No SourceCommit, 4:Untranslated
      sourceCommit: null, // 翻譯檔中紀錄的 hash
      currentCommit: null, // 英文檔當前的 hash
      url: `https://developer.mozilla.org/${TARGET_LOCALE}/docs/${relativePath.replace('.md', '').replace('/index', '')}`
    };

    // 獲取英文檔當前的最新 Commit Hash
    // 注意：這一步在大規模檔案時會比較慢，實際生產環境可用 git ls-tree 優化，這裡為了準確性使用 git log
    item.currentCommit = await getLatestCommitHash(CONTENT_REPO_PATH, path.relative(CONTENT_REPO_PATH, srcFileFull));

    if (!fs.existsSync(translatedFileFull)) {
      // 情況 4: 未翻譯
      item.status = 'untranslated';
    } else {
      // 讀取翻譯檔案的 Front Matter
      const fileContent = fs.readFileSync(translatedFileFull, 'utf8');
      const parsed = matter(fileContent);
      
      // MDN 翻譯檔通常在 front matter 中有 'sourceCommit' 欄位
      // 有些舊檔案可能是 'original_id' 或其他，這裡假設是標準的 sourceCommit
      const recordedCommit = parsed.data.sourceCommit;

      if (!recordedCommit) {
        // 情況 3: 翻譯未有 sourceCommit (或是格式錯誤)
        item.status = 'missing_meta';
      } else {
        item.sourceCommit = recordedCommit;
        
        if (recordedCommit === item.currentCommit) {
          // 情況 1: 翻譯在最新版本
          item.status = 'up_to_date';
        } else {
          // 情況 2: 需要更新
          item.status = 'outdated';
        }
      }
    }
    
    report.push(item);
    
    if (report.length % 100 === 0) {
      console.log(`已處理 ${report.length} 個檔案...`);
    }
  }

  // 確保輸出目錄存在
  fs.ensureDirSync(OUTPUT_DIR);
  
  // 寫入 JSON 資料
  fs.writeFileSync(path.join(OUTPUT_DIR, 'data.json'), JSON.stringify(report, null, 2));
  
  // 複製模板
  let template = fs.readFileSync('./template.html', 'utf8');
  // 可以在這裡做一些簡單的替換，或者直接讓 HTML 讀取 data.json
  fs.writeFileSync(path.join(OUTPUT_DIR, 'index.html'), template);

  console.log(`完成！報告已生成於 ${OUTPUT_DIR}/index.html`);
}

run().catch(err => console.error(err));