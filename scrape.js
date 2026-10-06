const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const GAS_WEBAPP_URL = process.env.GAS_WEBAPP_URL;
const DATA_FILE = path.join(__dirname, 'data.json');
const CONCURRENCY = 2; // 負荷軽減・確実な描画のため同時実行数を2に調整

function getJstTimestamp() {
  const now = new Date();
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  }).format(now);
}

async function scrapeProductPage(browser, url) {
  const page = await browser.newPage();
  
  // 画像やフォントの読み込みをブロックして高速化
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
      req.abort();
    } else {
      req.continue();
    }
  });

  try {
    // ネットワークが落ち着くまでしっかり待機
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    
    // 価格や要素が表示されるまで追加で待機（最大3秒）
    await new Promise(r => setTimeout(r, 3000));

    // 1. 商品番号
    const itemNumMatch = url.match(/\/p\/(\d+)/);
    const itemNumber = itemNumMatch ? itemNumMatch[1] : 'UNKNOWN';

    // 2. 商品名
    let title = '名称未取得';
    try {
      title = await page.evaluate(() => {
        const el = document.querySelector('h1.product-name, .product-details .name, h1');
        return el ? el.innerText.trim() : '名称未取得';
      });
    } catch (e) {}

    // 3. 価格・特売・期間・在庫の取得（DOMから直接抽出）
    const extractedData = await page.evaluate(() => {
      const bodyText = document.body.innerText;

      // 在庫確認
      const btn = document.querySelector('#add-to-cart-button, [data-qa="add-to-cart-button"], .add-to-cart');
      const isDisabled = btn ? (btn.disabled || btn.classList.contains('disabled')) : false;
      const oosText = !!document.querySelector('.out-of-stock, .not-available-online, [data-qa="out-of-stock"]');
      const isOutOfStock = isDisabled || oosText || bodyText.includes('在庫切れ') || bodyText.includes('現在オンラインではご購入いただけません');

      // 価格取得ロジック（複数パターン対応）
      let regularPrice = null;
      let salePrice = null;
      let isSale = false;

      // セレクタから価格を取得してみる
      const normalPriceEl = document.querySelector('.not-discounted-price, .product-price .price-value, [data-qa="product-price"]');
      const discountPriceEl = document.querySelector('.discount-price, .sale-price');

      if (normalPriceEl) {
        const pText = normalPriceEl.innerText.replace(/[^0-9]/g, '');
        if (pText) regularPrice = parseInt(pText, 10);
      }

      if (discountPriceEl) {
        const sText = discountPriceEl.innerText.replace(/[^0-9]/g, '');
        if (sText) {
          salePrice = parseInt(sText, 10);
          isSale = true;
        }
      }

      // テキスト正規表現によるフォールバック
      if (!regularPrice) {
        const onlineMatch = bodyText.match(/オンライン価格\s*[¥￥]?\s*([0-9,]+)/) || bodyText.match(/価格\s*[¥￥]?\s*([0-9,]+)/);
        if (onlineMatch) {
          regularPrice = parseInt(onlineMatch[1].replace(/,/g, ''), 10);
        }
      }

      // 特売期間の抽出
      let startDate = '', endDate = '';
      const dateMatch = bodyText.match(/([0-9]{4}\/[0-9]{1,2}\/[0-9]{1,2})[〜~～\s]*([0-9]{4}\/[0-9]{1,2}\/[0-9]{1,2})/) ||
                        bodyText.match(/割引価格は[（\(]?([0-9\/\.]+)[）\)]?から[（\(]?([0-9\/\.]+)[）\)]?/);
      if (dateMatch) {
        startDate = dateMatch[1];
        endDate = dateMatch[2];
        isSale = true;
      }

      return {
        regularPrice,
        salePrice,
        isSale,
        startDate,
        endDate,
        inStock: !isOutOfStock
      };
    });

    console.log(`  └ [${itemNumber}] ${title} | 通常:${extractedData.regularPrice ? extractedData.regularPrice + '円' : 'null'} | 特売:${extractedData.salePrice ? extractedData.salePrice + '円' : 'なし'} | 期間:${extractedData.startDate}〜${extractedData.endDate} | 在庫:${extractedData.inStock ? 'あり' : '切れ'}`);

    return {
      id: itemNumber,
      name: title,
      url,
      ...extractedData
    };

  } catch (err) {
    console.error(`  └ [エラー] ${url}: ${err.message}`);
    return null;
  } finally {
    await page.close();
  }
}

function compareData(oldData, newData) {
  const oldMap = new Map(oldData.map(item => [item.id, item]));
  const diffs = {
    newSale: [],
    priceDown: [],
    priceUp: [],
    backInStock: [],
    outOfStock: []
  };

  // 初回データ（oldDataが空）の場合、ログ用に全商品をチェックするか、差分のみ出すか
  for (const newItem of newData) {
    const oldItem = oldMap.get(newItem.id);
    if (!oldItem) continue; // 初回登録時は比較対象がないためスキップ

    // 特売開始判定
    if (!oldItem.isSale && newItem.isSale) {
      diffs.newSale.push({
        id: newItem.id,
        name: newItem.name,
        regularPrice: oldItem.regularPrice || newItem.regularPrice,
        salePrice: newItem.salePrice,
        diff: (oldItem.regularPrice || newItem.regularPrice) - newItem.salePrice,
        startDate: newItem.startDate,
        endDate: newItem.endDate
      });
    }

    // 値下がり判定
    if (!oldItem.isSale && !newItem.isSale && oldItem.regularPrice && newItem.regularPrice && newItem.regularPrice < oldItem.regularPrice) {
      diffs.priceDown.push({
        id: newItem.id,
        name: newItem.name,
        oldPrice: oldItem.regularPrice,
        newPrice: newItem.regularPrice,
        diff: oldItem.regularPrice - newItem.regularPrice
      });
    }

    // 値上がり判定
    if (!oldItem.isSale && !newItem.isSale && oldItem.regularPrice && newItem.regularPrice && newItem.regularPrice > oldItem.regularPrice) {
      diffs.priceUp.push({
        id: newItem.id,
        name: newItem.name,
        oldPrice: oldItem.regularPrice,
        newPrice: newItem.regularPrice,
        diff: newItem.regularPrice - oldItem.regularPrice
      });
    }

    // 在庫復活判定
    if (!oldItem.inStock && newItem.inStock) {
      diffs.backInStock.push({ id: newItem.id, name: newItem.name });
    }

    // 在庫切れ判定
    if (oldItem.inStock && !newItem.inStock) {
      diffs.outOfStock.push({ id: newItem.id, name: newItem.name });
    }
  }

  return diffs;
}

async function sendToGAS(timestamp, diffs) {
  if (!GAS_WEBAPP_URL) {
    console.warn('⚠️ GAS_WEBAPP_URLが設定されていないため送信をスキップします。');
    return;
  }
  try {
    console.log('🚀 GASへ変更履歴を送信中...');
    await axios.post(GAS_WEBAPP_URL, { timestamp, diffs });
    console.log('✅ GASへの送信が完了しました！');
  } catch (error) {
    console.error('❌ GAS送信エラー:', error.message);
  }
}

(async () => {
  console.log('=== コストコ監視実行開始 ===');

  if (!GAS_WEBAPP_URL) {
    console.error('エラー: GAS_WEBAPP_URL が設定されていません。');
    process.exit(1);
  }

  let urls = [];
  try {
    const res = await axios.get(GAS_WEBAPP_URL);
    urls = res.data;
  } catch (err) {
    console.error('URLリストの取得に失敗しました:', err.message);
    process.exit(1);
  }

  if (!Array.isArray(urls) || urls.length === 0) {
    console.log('監視対象のURLが登録されていません。');
    return;
  }

  console.log(`対象件数: ${urls.length} 件`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const newData = [];
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const chunk = urls.slice(i, i + CONCURRENCY);
    console.log(`[進捗] ${i + 1}〜${Math.min(i + CONCURRENCY, urls.length)} / ${urls.length} 件目を処理中...`);
    const results = await Promise.all(chunk.map(url => scrapeProductPage(browser, url)));
    newData.push(...results.filter(r => r !== null));
  }

  await browser.close();

  let oldData = [];
  if (fs.existsSync(DATA_FILE)) {
    try {
      oldData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    } catch (e) {}
  }

  const timestamp = getJstTimestamp();
  const diffs = compareData(oldData, newData);

  await sendToGAS(timestamp, diffs);

  fs.writeFileSync(DATA_FILE, JSON.stringify(newData, null, 2), 'utf-8');
  console.log('=== 全処理完了 ===');
})();
