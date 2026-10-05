const { chromium } = require('playwright');
const axios = require('axios');

const GAS_WEBAPP_URL = process.env.GAS_WEBAPP_URL;

async function scrapeProductPage(page, url, checkType) {
  console.log(`[取得開始] ${url}`);
  try {
    // 1. ページ遷移（ネットワークが安定するまで待機）
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    
    // 2. スクロール処理を追加（動的コンポーネントの読み込み発火用）
    await page.evaluate(() => window.scrollBy(0, 500));
    
    // 3. 画面レンダリング完了のためのしっかりとした固定待機（6秒）
    await page.waitForTimeout(6000);

    // 4. 在庫チェックの強化
    const bodyText = await page.innerText('body');
    
    // ボタンの状態やテキストから判定
    const isOutOfStock = await page.evaluate(() => {
      const addToCartBtn = document.querySelector('#add-to-cart-button, [data-qa="add-to-cart-button"], .add-to-cart');
      const isDisabled = addToCartBtn ? (addToCartBtn.disabled || addToCartBtn.classList.contains('disabled')) : false;
      const outOfStockText = !!document.querySelector('.out-of-stock, .not-available-online, [data-qa="out-of-stock"]');
      return isDisabled || outOfStockText;
    }) || bodyText.includes('在庫切れ') || bodyText.includes('現在オンラインではご購入いただけません');

    const stockStatus = isOutOfStock ? '在庫切れ' : '在庫あり';

    // 在庫チェック専用モード（12時・20時台）の場合はここで返却
    if (checkType === 'stock') {
      return { url, stockStatus };
    }

    // --- ここから全項目取得 (full モード) ---

    // 5. 商品番号
    const itemNumMatch = url.match(/\/p\/(\d+)/);
    const itemNumber = itemNumMatch ? itemNumMatch[1] : '';

    // 6. 商品名
    let title = '名称未取得';
    try {
      const titleEl = await page.waitForSelector('h1.product-name, .product-details .name, h1', { timeout: 5000 });
      if (titleEl) {
        title = (await titleEl.innerText()).trim();
      }
    } catch (e) {
      console.log(`  └ 商品名の取得をスキップ（要素未検出）`);
    }

    // 7. 特売期間・価格解析の強化
    let normalPrice = '';
    let salePrice = '';
    let startDate = '';
    let endDate = '';

    // 特売期間抽出: 「割引価格は（YYYY/MM/DD）から（YYYY/MM/DD）で有効です。」
    const dateMatch = bodyText.match(/割引価格は[（\(](\d{4}\/\d{1,2}\/\d{1,2})[）\)]から[（\(](\d{4}\/\d{1,2}\/\d{1,2})[）\)]/);
    if (dateMatch) {
      startDate = dateMatch[1];
      endDate = dateMatch[2];
    }

    // 価格表記パターンの判定
    // 通常価格
    const normalMatch = bodyText.match(/(?:通常価格|オンライン価格|元の価格)\s*[¥￥]\s*([0-9,]+)/) ||
                        bodyText.match(/¥\s*([0-9,]+)/);
    
    // 割引・オフ後価格
    const discountMatch = bodyText.match(/(?:割引後価格|オフ後価格|最終価格|割引価格|セール価格)\s*[¥￥]\s*([0-9,]+)/) ||
                          bodyText.match(/(?:OFF|割引|クーポン)\s*[¥￥]\s*([0-9,]+)/);

    if (dateMatch || discountMatch) {
      // 特売時
      if (normalMatch) normalPrice = normalMatch[1].replace(/,/g, '');
      if (discountMatch) {
        salePrice = discountMatch[1].replace(/,/g, '');
      } else {
        // オフ後価格の明示がない場合、一番大きく表示されている数字を解析
        const allPrices = [...bodyText.matchAll(/[¥￥]\s*([0-9,]+)/g)].map(m => parseInt(m[1].replace(/,/g, '')));
        if (allPrices.length >= 2) {
          normalPrice = String(Math.max(...allPrices));
          salePrice = String(Math.min(...allPrices));
        }
      }
    } else {
      // 通常時
      if (normalMatch) {
        normalPrice = normalMatch[1].replace(/,/g, '');
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
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 }
  });
  const page = await context.newPage();

  const scrapedItems = [];
  for (const url of targetUrls) {
    const itemData = await scrapeProductPage(page, url, checkType);
    scrapedItems.push(itemData);
    await page.waitForTimeout(4000); // 次の商品ページに移動する前の待機（4秒）
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
