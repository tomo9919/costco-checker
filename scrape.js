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

    // 1. 特売期間抽出
    const dateMatch = bodyText.match(/割引価格は[（\(](\d{4}\/\d{1,2}\/\d{1,2})[）\)]から[（\(](\d{4}\/\d{1,2}\/\d{1,2})[）\)]/);
    if (dateMatch) {
      startDate = dateMatch[1];
      endDate = dateMatch[2];
    }

    // 2. コストコオンラインの価格ブロック構造に基づいた正確な抽出
    // 「オンライン価格 ¥4,098」のような部分をキャプチャ
    const onlinePriceMatch = bodyText.match(/オンライン価格\s*[¥￥]\s*([0-9,]+)/);
    
    // 「価格 ¥3,278」や「オフ後価格 ¥3,278」のような最終価格部分をキャプチャ
    // （※「値引き - ¥820」の数字を拾わないよう、ラベル直後の金額を正確に狙う）
    const finalPriceMatch = bodyText.match(/(?:価格|オフ後価格|割引価格)\s*[¥￥]\s*([0-9,]+)/);

    if (dateMatch || onlinePriceMatch) {
      if (onlinePriceMatch) {
        normalPrice = onlinePriceMatch[1].replace(/,/g, '');
      }

      if (finalPriceMatch) {
        salePrice = finalPriceMatch[1].replace(/,/g, '');
      }

      // もし両方取れていて、かつ値引きされていない（通常価格と同じ）場合は特売価格を空にする
      if (normalPrice && salePrice && normalPrice === salePrice) {
        salePrice = '';
        startDate = '';
        endDate = '';
      }
    } else {
      // 特売情報がない通常の価格表記
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
