const { chromium } = require('playwright');

// ==========================================
// 設定項目
// ==========================================
// GASのウェブアプリURL（スプレッドシート連携用）
const GAS_WEBAPP_URL = process.env.GAS_WEBAPP_URL || 'YOUR_GAS_WEBAPP_URL_HERE';
// 実行モード ('full': 全項目取得, 'stock': 在庫のみ取得)
const RUN_MODE = process.env.RUN_MODE || 'full';

/**
 * コストコオンラインの価格および特売情報を抽出・パースする関数
 * @param {import('playwright').Page} page - Playwrightのページオブジェクト
 * @param {import('playwright').ElementHandle} productEl - 商品カードまたは商品詳細の要素
 */
async function parseCostcoPrices(page, productEl) {
  let regularPrice = null;
  let discountAmount = null;
  let finalPrice = null;
  let saleStartDate = null;
  let saleEndDate = null;

  try {
    // 1. 価格コンテナ全体のテキストを取得
    // ※ 実際のコストコオンラインのHTML構造（価格周辺のセレクタ）に合わせて調整してください
    const priceArea = await productEl.$('.price-box, .product-price, [data-qa="price-container"]');
    const fullText = priceArea ? await priceArea.textContent() : await productEl.textContent();
    
    // 文字列内の空白や改行を整理
    const cleanedText = fullText ? fullText.replace(/\s+/g, ' ') : '';

    // 2. 金額文字列を数値に変換するヘルパー
    const parseYen = (str) => {
      if (!str) return null;
      const match = str.replace(/,/g, '').match(/([0-9]+)/);
      return match ? parseInt(match[1], 10) : null;
    };

    // 3. 特売期間（例：「割引価格は2026/06/01から2026/06/07で有効です。」など）の抽出
    const dateRegex = /([0-9]{4}[\/\-][0-9]{1,2}[\/\-][0-9]{1,2})\s*から\s*([0-9]{4}[\/\-][0-9]{1,2}[\/\-][0-9]{1,2})/g;
    const dateMatch = dateRegex.exec(cleanedText);
    if (dateMatch) {
      saleStartDate = dateMatch[1];
      saleEndDate = dateMatch[2];
    }

    // 4. 個別要素（通常価格、値引き、特売価格）の取得試行
    const origPriceEl = await productEl.$('.old-price, .price-standard, .strike-price');
    if (origPriceEl) {
      regularPrice = parseYen(await origPriceEl.textContent());
    }

    const discountEl = await productEl.$('.discount-amount, .saving-price');
    if (discountEl) {
      discountAmount = parseYen(await discountEl.textContent());
    }

    const finalPriceEl = await productEl.$('.special-price, .regular-price, .sales-price');
    if (finalPriceEl) {
      finalPrice = parseYen(await finalPriceEl.textContent());
    }

    // 5. 個別要素で取得しきれなかった場合のフォールバック（正規表現によるテキスト解析）
    if (!finalPrice) {
      const allPrices = [...cleanedText.matchAll(/¥\s*([0-9,]+)/g)].map(m => parseYen(m[1]));
      if (allPrices.length >= 2) {
        regularPrice = allPrices[0];
        finalPrice = allPrices[1];
      } else if (allPrices.length === 1) {
        finalPrice = allPrices[0];
      }
    }

    // 値引き額や通常価格の相互補完計算
    if (regularPrice && discountAmount && !finalPrice) {
      finalPrice = regularPrice - discountAmount;
    } else if (regularPrice && finalPrice && !discountAmount) {
      discountAmount = regularPrice - finalPrice;
    }

  } catch (error) {
    console.error('価格パース中にエラーが発生しました:', error);
  }

  return {
    regularPrice,
    discountAmount,
    finalPrice,
    saleStartDate,
    saleEndDate
  };
}

/**
 * 在庫状態を判定する関数
 * @param {import('playwright').ElementHandle} productEl 
 */
async function parseStockStatus(productEl) {
  try {
    const stockEl = await productEl.$('.stock-status, .availability, .out-of-stock');
    if (stockEl) {
      const stockText = (await stockEl.textContent()).trim();
      if (stockText.includes('在庫なし') || stockText.includes('売り切れ')) {
        return '在庫なし';
      }
    }
    return '在庫あり';
  } catch (e) {
    return '不明';
  }
}

/**
 * GASから監視対象のURLリストを取得する関数
 */
async function fetchTargetUrls() {
  try {
    const response = await fetch(`${GAS_WEBAPP_URL}?action=getTargets`);
    const data = await response.json();
    return data.urls || []; // [{ id, url, name }, ...] の形式を想定
  } catch (error) {
    console.error('監視URLの取得に失敗しました:', error);
    return [];
  }
}

/**
 * スクレイピング結果をGASへ送信する関数
 */
async function sendResultsToGAS(results) {
  try {
    const response = await fetch(GAS_WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'saveResults', results })
    });
    const resultData = await response.json();
    console.log('GASへのデータ送信結果:', resultData);
  } catch (error) {
    console.error('GASへのデータ送信に失敗しました:', error);
  }
}

/**
 * メイン処理
 */
(async () => {
  console.log(`=== コストコ・チェッカー開始 (モード: ${RUN_MODE}) ===`);

  // 1. 監視URLの取得
  const targets = await fetchTargetUrls();
  if (!targets.length) {
    console.log('処理対象のURLがありません。終了します。');
    return;
  }

  // 2. ブラウザ起動
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  const scrapedResults = [];

  for (const target of targets) {
    try {
      console.log(`アクセス中: ${target.url}`);
      await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      
      // 必要に応じてスクロールや要素の待機を追加
      await page.waitForTimeout(2000);

      // 在庫ステータス取得
      const stockStatus = await parseStockStatus(page);

      let priceData = {
        regularPrice: null,
        discountAmount: null,
        finalPrice: null,
        saleStartDate: null,
        saleEndDate: null
      };

      // full モードの場合のみ価格詳細を取得
      if (RUN_MODE === 'full') {
        priceData = await parseCostcoPrices(page, page);
      }

      scrapedResults.push({
        id: target.id,
        url: target.url,
        stockStatus,
        ...priceData,
        scrapedAt: new Date().toISOString()
      });

    } catch (err) {
      console.error(`URLの処理中にエラー (${target.url}):`, err.message);
      scrapedResults.push({
        id: target.id,
        url: target.url,
        stockStatus: 'エラー',
        scrapedAt: new Date().toISOString()
      });
    }
  }

  await browser.close();

  // 3. GASへ結果を送信
  if (scrapedResults.length > 0) {
    await sendResultsToGAS(scrapedResults);
  }

  console.log('=== コストコ・チェッカー終了 ===');
})();
