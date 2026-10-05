const { chromium } = require('playwright');
const axios = require('axios');

const GAS_WEBAPP_URL = process.env.GAS_WEBAPP_URL;

async function scrapeProductPage(page, url, checkType) {
  console.log(`[取得開始] ${url}`);
  try {
    // ページ遷移（ネットワークが静かになるまで待機）
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    
    // 画面レンダリング完了のための固定待機（3秒）
    await page.waitForTimeout(3000);

    // 1. 在庫チェック
    const outOfStockEl = await page.$('.out-of-stock, .not-available-online, [data-qa="out-of-stock"]');
    const stockStatus = outOfStockEl ? '在庫切れ' : '在庫あり';

    // 在庫チェック専用モード（12時・20時台）の場合はここで返却
    if (checkType === 'stock') {
      return { url, stockStatus };
    }

    // --- ここから全項目取得（6時台） ---

    // 2. 商品番号
    const itemNumMatch = url.match(/\/p\/(\d+)/);
    const itemNumber = itemNumMatch ? itemNumMatch[1] : '';

    // 3. 商品名（要素が表示されるまで最大5秒待つ）
    let title = '名称未取得';
    try {
      const titleEl = await page.waitForSelector('h1.product-name, .product-details .name, h1', { timeout: 5000 });
      if (titleEl) {
        title = (await titleEl.innerText()).trim();
      }
    } catch (e) {
      console.log(`  └ 商品名の取得をスキップ（要素未検出）`);
    }

    // 4. 価格 & 特売情報の解析
    let normalPrice = '';
    let salePrice = '';
    let startDate = '';
    let endDate = '';

    const bodyText = await page.innerText('body');
    
    // 特売期間抽出: 「割引価格は（YYYY/MM/DD）から（YYYY/MM/DD）で有効です。」
    const dateMatch = bodyText.match(/割引価格は[（\(](\d{4}\/\d{1,2}\/\d{1,2})[）\)]から[（\(](\d{4}\/\d{1,2}\/\d{1,2})[）\)]/);
    if (dateMatch) {
      startDate = dateMatch[1];
      endDate = dateMatch[2];
    }

    // 価格表記パターンの判定
    const normalPriceMatch = bodyText.match(/オンライン価格\s*[¥￥]([0-9,]+)/);
    const finalPriceMatch = bodyText.match(/(?:価格|オフ後価格)\s*[¥￥]([0-9,]+)/);

    if (normalPriceMatch && finalPriceMatch) {
      // 特売時
      normalPrice = normalPriceMatch[1].replace(/,/g, '');
      salePrice = finalPriceMatch[1].replace(/,/g, '');
    } else {
      // 通常時
      const singlePriceMatch = bodyText.match(/価格\s*[¥￥]([0-9,]+)/) || bodyText.match(/¥\s*([0-9,]+)/);
      normalPrice = singlePriceMatch ? singlePriceMatch[1].replace(/,/g, '') : '';
      salePrice = '';
      startDate = '';
      endDate = '';
    }

    console.log(`  └ 取得結果: [${itemNumber}] ${title} / 通常:${normalPrice} / 特売:${salePrice} / 在庫:${stockStatus}`);

    return { url, itemNumber, title, normalPrice, salePrice, startDate, endDate, stockStatus };
  } catch (err) {
    console.error(`[エラー] ${url}: ${err.message}`);
    return { url, stockStatus: 'エラー' };
  }
}

(async () => {
  // 環境変数 CHECK_TYPE が指定されていない場合は 'full'（全項目取得）をデフォルトにする
  const checkType = process.env.CHECK_TYPE || 'full';
  console.log(`=== コストコ監視実行中 (モード: ${checkType}) ===`);

  if (!GAS_WEBAPP_URL) {
    console.error('エラー: GAS_WEBAPP_URL が設定されていません。');
    process.exit(1);
  }

  console.log('監視対象URLを取得中...');
  let targetUrls = [];
  try {
    const res = await axios.get(GAS_WEBAPP_URL);
    targetUrls = res.data;
    console.log(`取得対象件数: ${targetUrls.length} 件`);
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
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  const scrapedItems = [];
  for (const url of targetUrls) {
    const itemData = await scrapeProductPage(page, url, checkType);
    scrapedItems.push(itemData);
    await page.waitForTimeout(3000); // 次のページに遷移する前の待機（3秒）
  }

  await browser.close();

  const now = new Date();
  const timestamp = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  }).format(now);

  console.log('結果をスプレッドシートへ送信中...');
  try {
    const response = await axios.post(GAS_WEBAPP_URL, {
      checkType,
      timestamp,
      items: scrapedItems
    });
    console.log('送信完了:', response.data);
  } catch (error) {
    console.error('送信失敗:', error.message);
  }
})();
