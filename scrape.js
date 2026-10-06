const { chromium } = require('playwright');
const axios = require('axios');

const GAS_WEBAPP_URL = process.env.GAS_WEBAPP_URL;

async function scrapeProductPage(page, url, checkType) {
  console.log(`[取得開始] ${url}`);
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    await page.evaluate(() => window.scrollBy(0, 500));
    await page.waitForTimeout(6000);

    const bodyText = await page.innerText('body');
    
    // 在庫チェック
    const isOutOfStock = await page.evaluate(() => {
      const addToCartBtn = document.querySelector('#add-to-cart-button, [data-qa="add-to-cart-button"], .add-to-cart');
      const isDisabled = addToCartBtn ? (addToCartBtn.disabled || addToCartBtn.classList.contains('disabled')) : false;
      const outOfStockText = !!document.querySelector('.out-of-stock, .not-available-online, [data-qa="out-of-stock"]');
      return isDisabled || outOfStockText;
    }) || bodyText.includes('在庫切れ') || bodyText.includes('現在オンラインではご購入いただけません');

    const stockStatus = isOutOfStock ? '在庫切れ' : '在庫あり';

    if (checkType === 'stock') {
      return { url, stockStatus };
    }

    const itemNumMatch = url.match(/\/p\/(\d+)/);
    const itemNumber = itemNumMatch ? itemNumMatch[1] : '';

    let title = '名称未取得';
    try {
      const titleEl = await page.waitForSelector('h1.product-name, .product-details .name, h1', { timeout: 5000 });
      if (titleEl) {
        title = (await titleEl.innerText()).trim();
      }
    } catch (e) {
      console.log(`  └ 商品名の取得をスキップ（要素未検出）`);
    }

    let normalPrice = '';
    let salePrice = '';
    let startDate = '';
    let endDate = '';

    // 1. 特売期間の抽出
    const dateMatch = bodyText.match(/割引価格は[（\(](\d{4}\/\d{1,2}\/\d{1,2})[）\)]から[（\(](\d{4}\/\d{1,2}\/\d{1,2})[）\)]/);
    if (dateMatch) {
      startDate = dateMatch[1];
      endDate = dateMatch[2];
    }

    // 2. 価格のクリーンな抽出（「オンライン価格」と、値引きではない独立した「価格」を厳密に区別）
    const priceData = await page.evaluate(() => {
      const text = document.body.innerText;
      
      // ① 「オンライン価格」の直後にある金額（例: オンライン価格 ¥1,998）
      const onlineMatch = text.match(/オンライン価格\s*[¥￥]\s*([0-9,]+)/);
      
      // ② 「値引き」の行を除外した上で、独立した「価格 ¥XXXX」の金額を狙う
      // （「値引き - ¥370」のようなマイナス付きの金額や、文言中の数字を避ける）
      let finalVal = '';
      
      // 改行区切りで「価格」という単語の独立した行を探す
      const lines = text.split('\n').map(l => l.trim());
      for (let i = 0; i < lines.length; i++) {
        // 「価格」という文字だけの行、または「価格 ¥1,628」のようになっている行を検出
        if (lines[i] === '価格' && lines[i + 1] && /^[¥￥][0-9,]+$/.test(lines[i + 1])) {
          finalVal = lines[i + 1].replace(/[¥￥,]/g, '');
          break;
        }
        // 「価格 ¥1,628」が1行に収まっているパターン
        const matchInLine = lines[i].match(/^価格\s*[¥￥]\s*([0-9,]+)$/);
        if (matchInLine) {
          finalVal = matchInLine[1].replace(/,/g, '');
          break;
        }
      }

      return {
        online: onlineMatch ? onlineMatch[1].replace(/,/g, '') : '',
        final: finalVal
      };
    });

    if (dateMatch || priceData.online) {
      normalPrice = priceData.online;

      // 最終価格（特売価格）が存在し、かつオンライン価格と違う場合のみ特売価格として採用
      if (priceData.final && priceData.final !== priceData.online) {
        salePrice = priceData.final;
      } else {
        // 特売期間はないが「オンライン価格」のみの通常商品の場合
        salePrice = '';
        startDate = '';
        endDate = '';
      }
    } else {
      // 特売情報もオンライン価格表記もない場合のフォールバック（通常時）
      const singleMatch = bodyText.match(/価格\s*[¥￥]\s*([0-9,]+)/) || bodyText.match(/¥\s*([0-9,]+)/);
      if (singleMatch) {
        normalPrice = singleMatch[1].replace(/,/g, '');
      }
      salePrice = '';
      startDate = '';
      endDate = '';
    }

    console.log(`  └ 取得結果: [${itemNumber}] ${title} | 通常:${normalPrice} | 特売:${salePrice} (${startDate}〜${endDate}) | 在庫:${stockStatus}`);

    return { url, itemNumber, title, normalPrice, salePrice, startDate, endDate, stockStatus };
  } catch (err) {
    console.error(`[エラー] ${url}: ${err.message}`);
    return { url, stockStatus: 'エラー' };
  }
}

(async () => {
  const checkType = process.env.CHECK_TYPE || 'full';
  console.log(`=== コストコ監視実行中 (モード: ${checkType}) ===`);

  if (!GAS_WEBAPP_URL) {
    console.error('エラー: GAS_WEBAPP_URL が設定されていません。');
    process.exit(1);
  }

  let targetUrls = [];
  try {
    const res = await axios.get(GAS_WEBAPP_URL);
    targetUrls = res.data;
  } catch (err) {
    console.error('URLリストの取得に失敗しました:', err.message);
    process.exit(1);
  }

  if (targetUrls.length === 0) {
    console.log('監視対象のURLがスプレッドシートに登録されていません。');
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 }
  });
  const page = await context.newPage();

  const scrapedItems = [];
  for (const url of targetUrls) {
    const itemData = await scrapeProductPage(page, url, checkType);
    scrapedItems.push(itemData);
    await page.waitForTimeout(4000);
  }

  await browser.close();

  const now = new Date();
  const timestamp = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  }).format(now);

  try {
    await axios.post(GAS_WEBAPP_URL, {
      checkType,
      timestamp,
      items: scrapedItems
    });
    console.log('送信完了');
  } catch (error) {
    console.error('送信失敗:', error.message);
  }
})();
