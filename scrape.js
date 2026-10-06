const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const GAS_WEBAPP_URL = process.env.GAS_WEBAPP_URL;
const DATA_FILE = path.join(__dirname, 'data.json');
const CONCURRENCY = 3;

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
  
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
      req.abort();
    } else {
      req.continue();
    }
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForSelector('body', { timeout: 5000 });

    const bodyText = await page.evaluate(() => document.body.innerText);

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

    // 3. 在庫状況
    const isOutOfStock = await page.evaluate(() => {
      const btn = document.querySelector('#add-to-cart-button, [data-qa="add-to-cart-button"], .add-to-cart');
      const isDisabled = btn ? (btn.disabled || btn.classList.contains('disabled')) : false;
      const oosText = !!document.querySelector('.out-of-stock, .not-available-online, [data-qa="out-of-stock"]');
      return isDisabled || oosText;
    }) || bodyText.includes('在庫切れ') || bodyText.includes('現在オンラインではご購入いただけません');

    const inStock = !isOutOfStock;

    // 4. 特売開始・特売終了日
    let startDate = '', endDate = '';
    const dateMatch = bodyText.match(/割引価格は[（\(](\d{4}\/\d{1,2}\/\d{1,2})[）\)]から[（\(](\d{4}\/\d{1,2}\/\d{1,2})[）\)]/);
    if (dateMatch) {
      startDate = dateMatch[1];
      endDate = dateMatch[2];
    }

    // 5. 通常価格・特売価格
    const priceData = await page.evaluate(() => {
      const text = document.body.innerText;
      const onlineMatch = text.match(/オンライン価格\s*[¥￥]\s*([0-9,]+)/);
      
      let finalVal = '';
      const lines = text.split('\n').map(l => l.trim());
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] === '価格' && lines[i + 1] && /^[¥￥][0-9,]+$/.test(lines[i + 1])) {
          finalVal = lines[i + 1].replace(/[¥￥,]/g, '');
          break;
        }
        const matchInLine = lines[i].match(/^価格\s*[¥￥]\s*([0-9,]+)$/);
        if (matchInLine) {
          finalVal = matchInLine[1].replace(/,/g, '');
          break;
        }
      }

      return {
        online: onlineMatch ? parseInt(onlineMatch[1].replace(/,/g, ''), 10) : null,
        final: finalVal ? parseInt(finalVal, 10) : null
      };
    });

    let regularPrice = priceData.online;
    let salePrice = null;
    let isSale = false;

    if (priceData.final && priceData.online && priceData.final !== priceData.online) {
      salePrice = priceData.final;
      isSale = true;
    } else if (!regularPrice) {
      const singleMatch = bodyText.match(/価格\s*[¥￥]\s*([0-9,]+)/);
      if (singleMatch) regularPrice = parseInt(singleMatch[1].replace(/,/g, ''), 10);
    }

    console.log(`  └ [${itemNumber}] ${title} | 通常:${regularPrice}円 | 特売:${salePrice ? salePrice + '円' : 'なし'} | 期間:${startDate}〜${endDate} | 在庫:${inStock ? 'あり' : '切れ'}`);

    return {
      id: itemNumber,
      name: title,
      url,
      regularPrice,
      salePrice,
      isSale,
      startDate,
      endDate,
      inStock
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

  for (const newItem of newData) {
    const oldItem = oldMap.get(newItem.id);
    if (!oldItem) continue;

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
  console.log('=== コストコ監視実行開始 (B列URL読み込みモード) ===');

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
    console.log('監視対象のURLが登録されていません。（監視リストのB列を確認してください）');
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
