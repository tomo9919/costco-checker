const puppeteer = require('puppeteer');
const fs = require('fs');

// 並列処理数（3〜4個程度がコストコ側への負荷とスピードのバランスが最適です）
const CONCURRENCY = 3;

// 前回のデータを読み込み（差分比較用）
function loadPreviousData() {
  if (fs.existsSync('previous_data.json')) {
    try {
      return JSON.parse(fs.readFileSync('previous_data.json', 'utf8'));
    } catch (e) {
      return {};
    }
  }
  return {};
}

// データを保存
function saveData(data) {
  fs.writeFileSync('previous_data.json', JSON.stringify(data, null, 2), 'utf8');
}

// 日本時間のフォーマット文字列を取得
function getFormattedDate() {
  const now = new Date();
  const jstNow = new Date(now.getTime() + (9 * 60 + now.getTimezoneOffset()) * 60000);
  const yyyy = jstNow.getFullYear();
  const mm = String(jstNow.getMonth() + 1).padStart(2, '0');
  const dd = String(jstNow.getDate()).padStart(2, '0');
  const hh = String(jstNow.getHours()).padStart(2, '0');
  const mi = String(jstNow.getMinutes()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd} ${hh}:${mi}`;
}

// 単一商品の取得処理（高速化対応）
async function fetchProduct(browser, url) {
  const page = await browser.newPage();
  
  // 【高速化1】画像・動画・CSS・フォントの読み込みを無効化して通信量を激減
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const resourceType = req.resourceType();
    if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  try {
    // 【高速化2】waitUntilを'domcontentloaded'に変更し、文字骨組み読込で即スタート
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // 【高速化3】固定秒数の待機を排除し、価格要素が表示された瞬間に次へ進む
    await page.waitForSelector('.product-details, .not-available, .price', { timeout: 8000 }).catch(() => {});

    // 商品データ解析（既存の抽出ロジック）
    const itemData = await page.evaluate(() => {
      const idMatch = window.location.href.match(/\/p\/(\d+)/);
      const id = idMatch ? idMatch[1] : 'UNKNOWN';
      
      const titleElem = document.querySelector('h1.name') || document.querySelector('.product-name');
      const name = titleElem ? titleElem.innerText.trim() : '商品名不明';

      // 在庫確認
      const outOfStockElem = document.querySelector('.out-of-stock, .not-available-online');
      const inStock = !outOfStockElem;

      // 価格取得
      const regPriceElem = document.querySelector('.price-value, .your-price .value');
      const regularPrice = regPriceElem ? parseInt(regPriceElem.innerText.replace(/[^0-9]/g, ''), 10) : null;

      // 特売価格取得
      const salePriceElem = document.querySelector('.discount-price, .instant-savings');
      const salePrice = salePriceElem ? parseInt(salePriceElem.innerText.replace(/[^0-9]/g, ''), 10) : null;

      // 特売期間
      const periodElem = document.querySelector('.promo-discount-dates, .discount-dates');
      const period = periodElem ? periodElem.innerText.trim() : '';

      return { id, name, inStock, regularPrice, salePrice, period };
    });

    itemData.url = url;
    return itemData;

  } catch (error) {
    console.error(`[Error] 取得失敗: ${url} (${error.message})`);
    return null;
  } finally {
    await page.close();
  }
}

// 並列処理コントロール
async function fetchAllProducts(browser, urls) {
  const results = [];
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const chunk = urls.slice(i, i + CONCURRENCY);
    console.log(`[進捗] ${i + 1}〜${Math.min(i + CONCURRENCY, urls.length)} / ${urls.length} 件目を処理中...`);
    const chunkResults = await Promise.all(chunk.map(url => fetchProduct(browser, url)));
    results.push(...chunkResults.filter(res => res !== null));
  }
  return results;
}

// 変更履歴ログの作成
function generateChangeLog(previousData, currentResults) {
  const timestamp = getFormattedDate();
  
  const diffs = {
    newSale: [],
    priceDown: [],
    priceUp: [],
    backInStock: [],
    outOfStock: []
  };

  const currentMap = {};

  for (const item of currentResults) {
    currentMap[item.id] = item;
    const prev = previousData[item.id];

    if (!prev) continue; // 初回取得時は比較対象がないためスキップ

    // 1. 新規特売スタート
    if (!prev.salePrice && item.salePrice) {
      diffs.newSale.push({
        name: item.name,
        id: item.id,
        regularPrice: item.regularPrice,
        salePrice: item.salePrice,
        diff: item.regularPrice ? item.regularPrice - item.salePrice : 0,
        period: item.period || '期間未記載'
      });
    }

    // 2. 価格変更：値下がり (通常価格の値下げ)
    else if (prev.regularPrice && item.regularPrice && item.regularPrice < prev.regularPrice) {
      diffs.priceDown.push({
        name: item.name,
        id: item.id,
        oldPrice: prev.regularPrice,
        newPrice: item.regularPrice,
        diff: prev.regularPrice - item.regularPrice
      });
    }

    // 3. 価格変更：値上がり (通常価格の値上げ)
    else if (prev.regularPrice && item.regularPrice && item.regularPrice > prev.regularPrice) {
      diffs.priceUp.push({
        name: item.name,
        id: item.id,
        oldPrice: prev.regularPrice,
        newPrice: item.regularPrice,
        diff: item.regularPrice - prev.regularPrice
      });
    }

    // 4. 在庫ステータス：復活
    if (!prev.inStock && item.inStock) {
      diffs.backInStock.push({ name: item.name, id: item.id });
    }

    // 5. 在庫ステータス：切れ
    if (prev.inStock && !item.inStock) {
      diffs.outOfStock.push({ name: item.name, id: item.id });
    }
  }

  // テキスト形式の変更履歴を整形
  let logText = `============================================================\n`;
  logText += `【${timestamp} 実行】\n`;
  logText += `============================================================\n\n`;

  let hasChange = false;

  if (diffs.newSale.length > 0) {
    hasChange = true;
    logText += `■ 新規特売スタート\n`;
    diffs.newSale.forEach(i => {
      logText += `  ・${i.name} (${i.id})\n    通常: ${i.regularPrice?.toLocaleString()}円 ➔ 特売: ${i.salePrice?.toLocaleString()}円 (-${i.diff.toLocaleString()}円) [期間: ${i.period}]\n\n`;
    });
  }

  if (diffs.priceDown.length > 0) {
    hasChange = true;
    logText += `■ 価格変更：値下がり\n`;
    diffs.priceDown.forEach(i => {
      logText += `  ・${i.name} (${i.id})\n    通常価格: ${i.oldPrice?.toLocaleString()}円 ➔ ${i.newPrice?.toLocaleString()}円 (-${i.diff.toLocaleString()}円)\n\n`;
    });
  }

  if (diffs.priceUp.length > 0) {
    hasChange = true;
    logText += `■ 価格変更：値上がり\n`;
    diffs.priceUp.forEach(i => {
      logText += `  ・${i.name} (${i.id})\n    通常価格: ${i.oldPrice?.toLocaleString()}円 ➔ ${i.newPrice?.toLocaleString()}円 (+${i.diff.toLocaleString()}円)\n\n`;
    });
  }

  if (diffs.backInStock.length > 0) {
    hasChange = true;
    logText += `■ 在庫ステータス：復活 🎉\n`;
    diffs.backInStock.forEach(i => {
      logText += `  ・${i.name} (${i.id})\n    在庫切れ ➔ 在庫あり\n\n`;
    });
  }

  if (diffs.outOfStock.length > 0) {
    hasChange = true;
    logText += `■ 在庫ステータス：切れ 💦\n`;
    diffs.outOfStock.forEach(i => {
      logText += `  ・${i.name} (${i.id})\n    在庫あり ➔ 在庫切れ\n\n`;
    });
  }

  if (!hasChange) {
    logText += `（※今回の実行で変動のあった項目はありません）\n\n`;
  }

  return { logText, currentMap };
}

// メイン実行部
(async () => {
  console.log('=== コストコ監視実行開始 (高速化モード) ===');
  
  // 監視対象URLリスト (適宜読み込み処理に書き換えてください)
  const urls = [
    'https://www.costco.co.jp/c/arFUM-Ball-type-Laundry-Detergent-120-CT/p/72800',
    'https://www.costco.co.jp/c/Dove-Premium-Body-Wash-Refill-3kg/p/57777',
    // ... 対象URLを追加
  ];

  const browser = await puppeteer.launch({
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const previousData = loadPreviousData();
  const currentResults = await fetchAllProducts(browser, urls);
  
  await browser.close();

  // 差分比較とログ整形
  const { logText, currentMap } = generateChangeLog(previousData, currentResults);

  console.log('\n--- 変更履歴出力結果 ---');
  console.log(logText);

  // 今回のデータを保存 (次回の比較用)
  saveData(currentMap);

  // ログファイル追記（上から最新の順にする場合は、読み込んで先頭に結合して保存）
  let historyContent = '';
  if (fs.existsSync('change_log.txt')) {
    historyContent = fs.readFileSync('change_log.txt', 'utf8');
  }
  fs.writeFileSync('change_log.txt', logText + historyContent, 'utf8');

  console.log('=== 処理完了 ===');
})();
const axios = require('axios'); // または node-fetch

// GASのWebアプリURL（ステップ2で取得したもの）
// GitHub SecretsからURLを読み込みます
const GAS_WEBAPP_URL = process.env.GAS_WEBAPP_URL;

async function sendToGAS(timestamp, diffs) {
  if (!GAS_WEBAPP_URL) {
    console.error('GAS_WEBAPP_URL が設定されていません');
    return;
  }
  
  try {
    console.log('GASへ変更履歴を送信中...');
    await axios.post(GAS_WEBAPP_URL, {
      timestamp: timestamp,
      diffs: diffs
    });
    console.log('GASへの送信が完了しました！');
  } catch (error) {
    console.error('GAS送信エラー:', error.message);
  }
}
