const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const GAS_WEBAPP_URL = process.env.GAS_WEBAPP_URL;
const CHECK_MODE = process.env.CHECK_MODE; // 'stock_only' かどうかを判定
const DATA_FILE = path.join(__dirname, 'data.json');

// ★並列処理数（4件並列）
const CONCURRENCY = 4;

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
  
  // ユーザーエージェントを設定してブロックリスクを軽減
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const resourceType = req.resourceType();
    const reqUrl = req.url().toLowerCase();

    // 不要なリソース（画像・スタイル・フォント）＋ 追跡・分析用トラッカーを遮断
    if (
      ['image', 'stylesheet', 'font', 'media'].includes(resourceType) ||
      reqUrl.includes('google-analytics') ||
      reqUrl.includes('analytics') ||
      reqUrl.includes('doubleclick') ||
      reqUrl.includes('facebook') ||
      reqUrl.includes('hotjar')
    ) {
      req.abort();
    } else {
      req.continue();
    }
  });

  try {
    // 確実なデータ取得のため networkidle2 に設定（タイムアウトは30秒）
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});

    // 価格要素または商品名のレンダリング完了を最大8秒待機
    await page.waitForSelector('.price-original, .notranslate, .product-price, h1', { timeout: 8000 }).catch(() => {});
    
    // JSの動的描画（価格の埋め込み）を確実にするため3秒待機
    await new Promise(r => setTimeout(r, 3000));

    // 1. 商品番号
    const itemNumMatch = url.match(/\/p\/(\d+)/);
    const itemNumber = itemNumMatch ? itemNumMatch[1] : 'UNKNOWN';

    // 2. 商品名
    let title = '名称未取得';
    try {
      title = await page.evaluate(() => {
        const el = document.querySelector('h1.product-name, .product-details .name, h1');
        return el ? (el.innerText || '').trim() : '名称未取得';
      });
    } catch (e) {}

    // 3. 価格・特売・期間・在庫の抽出
    const extractedData = await page.evaluate(() => {
      const bodyText = document.body.innerText || '';

      // 在庫確認
      const btn = document.querySelector('#add-to-cart-button, [data-qa="add-to-cart-button"], .add-to-cart');
      const isDisabled = btn ? (btn.disabled || btn.classList.contains('disabled')) : false;
      const oosText = !!document.querySelector('.out-of-stock, .not-available-online, [data-qa="out-of-stock"]');
      const isOutOfStock = isDisabled || oosText || bodyText.includes('在庫切れ') || bodyText.includes('現在オンラインではご購入いただけません');

      // 特売期間の抽出
      let startDate = '', endDate = '';
      const dateMatch = bodyText.match(/([0-9]{4}\/[0-9]{1,2}\/[0-9]{1,2})[〜~～\s]*([0-9]{4}\/[0-9]{1,2}\/[0-9]{1,2})/) ||
                        bodyText.match(/割引価格は[（\(]?([0-9\/\.]+)[）\)]?から[（\(]?([0-9\/\.]+)[）\)]?/);
      if (dateMatch) {
        startDate = dateMatch[1];
        endDate = dateMatch[2];
      }

      // 特売価格（you-pay-value）の取得
      let salePrice = null;
      const youPayEl = document.querySelector('.you-pay-value');
      if (youPayEl) {
        const priceText = (youPayEl.innerText || '').replace(/[¥￥,]/g, '').trim();
        const p = parseInt(priceText, 10);
        if (!isNaN(p)) {
          salePrice = p;
        }
      }

      // 通常価格の取得
      let regularPrice = null;

      // 1. 最優先: .price-original クラス内の価格要素を取得
      const priceOriginalEl = document.querySelector('.price-original');
      if (priceOriginalEl) {
        const notranslateEl = priceOriginalEl.querySelector('.notranslate');
        if (notranslateEl) {
          const text = (notranslateEl.innerText || '').trim();
          const num = parseInt(text.replace(/[¥￥,]/g, ''), 10);
          if (!isNaN(num)) {
            regularPrice = num;
          }
        }
        
        if (!regularPrice) {
          const text = (priceOriginalEl.innerText || '').trim();
          const match = text.match(/[¥￥]\s*([0-9,]+)/);
          if (match) {
            const num = parseInt(match[1].replace(/,/g, ''), 10);
            if (!isNaN(num)) {
              regularPrice = num;
            }
          }
        }
      }

      // 2. 第2候補: 「オンライン価格」ラベルを持つ要素の周辺から探索
      if (!regularPrice) {
        const allElements = Array.from(document.querySelectorAll('*'));
        const onlinePriceLabelEl = allElements.find(el => el.children.length === 0 && (el.innerText || '').trim() === 'オンライン価格');
        
        if (onlinePriceLabelEl) {
          let container = onlinePriceLabelEl.parentElement;
          for (let i = 0; i < 3 && container; i++) {
            const priceEl = container.querySelector('.notranslate.ng-star-inserted, .price-value');
            if (priceEl) {
              const text = (priceEl.innerText || '').trim();
              if (text.includes('¥') || text.includes('￥')) {
                const num = parseInt(text.replace(/[¥￥,]/g, ''), 10);
                if (!isNaN(num)) {
                  regularPrice = num;
                  break;
                }
              }
            }
            container = container.parentElement;
          }
        }
      }

      // 3. 第3候補: メインエリア内に限定したフォールバック
      if (!regularPrice) {
        const mainContainer = document.querySelector('.product-price-detail, .product-details, #product-details') || document.body;
        const priceElements = Array.from(mainContainer.querySelectorAll('.notranslate.ng-star-inserted, .product-price, [data-qa="product-price"]'))
          .filter(el => {
            const text = (el.innerText || '').trim();
            return text.includes('¥') || text.includes('￥');
          });

        const prices = [];
        priceElements.forEach(el => {
          const text = (el.innerText || '').trim();
          if (text.match(/^[¥￥]?[0-9,]+\$/)) {
            const num = parseInt(text.replace(/[¥￥,]/g, ''), 10);
            if (!isNaN(num) && num > 100 && !prices.includes(num)) {
              prices.push(num);
            }
          }
        });

        if (salePrice !== null) {
          const higherPrices = prices.filter(p => p > salePrice);
          if (higherPrices.length > 0) {
            regularPrice = Math.max(...higherPrices);
          } else if (prices.length > 0) {
            regularPrice = Math.max(...prices);
          }
        } else {
          if (prices.length > 0) {
            regularPrice = Math.max(...prices);
          }
        }
      }

      let isSale = false;
      if (salePrice !== null && regularPrice !== null && regularPrice > salePrice) {
        isSale = true;
      } else if (salePrice !== null && regularPrice === null) {
        regularPrice = salePrice;
        salePrice = null;
        isSale = false;
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

  const isStockOnly = CHECK_MODE === 'stock_only';

  for (const newItem of newData) {
    const oldItem = oldMap.get(newItem.id);
    if (!oldItem) continue;

    const oldInStock = Boolean(oldItem.inStock);
    const newInStock = Boolean(newItem.inStock);

    if (!oldInStock && newInStock) {
      diffs.backInStock.push({ id: newItem.id, name: newItem.name, url: newItem.url });
    }

    if (oldInStock && !newInStock) {
      diffs.outOfStock.push({ id: newItem.id, name: newItem.name, url: newItem.url });
    }

    if (isStockOnly) continue;

    if (!oldItem.isSale && newItem.isSale) {
      diffs.newSale.push({
        id: newItem.id,
        name: newItem.name,
        url: newItem.url,
        regularPrice: oldItem.regularPrice || newItem.regularPrice,
        salePrice: newItem.salePrice,
        diff: (oldItem.regularPrice || newItem.regularPrice) - newItem.salePrice,
        startDate: newItem.startDate,
        endDate: newItem.endDate
      });
    }

    if (!oldItem.isSale && !newItem.isSale && oldItem.regularPrice && newItem.regularPrice && newItem.regularPrice < oldItem.regularPrice) {
      diffs.priceDown.push({
        id: newItem.id,
        name: newItem.name,
        url: newItem.url,
        oldPrice: oldItem.regularPrice,
        newPrice: newItem.regularPrice,
        diff: oldItem.regularPrice - newItem.regularPrice
      });
    }

    if (!oldItem.isSale && !newItem.isSale && oldItem.regularPrice && newItem.regularPrice && newItem.regularPrice > oldItem.regularPrice) {
      diffs.priceUp.push({
        id: newItem.id,
        name: newItem.name,
        url: newItem.url,
        oldPrice: oldItem.regularPrice,
        newPrice: newItem.regularPrice,
        diff: newItem.regularPrice - oldItem.regularPrice
      });
    }
  }

  return diffs;
}

async function sendToGAS(timestamp, diffs, items) {
  if (!GAS_WEBAPP_URL) {
    console.warn('⚠️ GAS_WEBAPP_URLが設定されていないため送信をスキップします。');
    return;
  }
  try {
    console.log('🚀 GASへデータを送信中...');
    await axios.post(GAS_WEBAPP_URL, { timestamp, diffs, items });
    console.log('✅ GASへの送信が完了しました！');
  } catch (error) {
    console.error('❌ GAS送信エラー:', error.message);
  }
}

(async () => {
  console.log(`=== コストコ監視実行開始 (モード: ${CHECK_MODE === 'stock_only' ? '在庫のみ' : '全項目'}) ===`);

  if (!GAS_WEBAPP_URL) {
    console.error('エラー: GAS_WEBAPP_URL が設定されていません。');
    process.exit(1);
  }

  let urls = [];
  const maxRetries = 3;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`URLリストを取得中... (試行 ${attempt}/${maxRetries})`);
      const res = await axios.get(GAS_WEBAPP_URL, { timeout: 10000 });
      if (Array.isArray(res.data)) {
        urls = res.data;
        break;
      }
    } catch (err) {
      console.warn(`⚠️ URLリスト取得失敗 (${attempt}/${maxRetries}): ${err.message}`);
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }

  if (!Array.isArray(urls) || urls.length === 0) {
    console.error('❌ URLリストの取得に失敗したか、監視対象のURLが0件です。処理をスキップして終了します。');
    return;
  }

  console.log(`対象件数: ${urls.length} 件 (並列数: ${CONCURRENCY})`);

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

  // --- 履歴データの読み込み（配列として保持） ---
  let history = [];
  if (fs.existsSync(DATA_FILE)) {
    try {
      const fileData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      if (Array.isArray(fileData)) {
        history = fileData;
      }
    } catch (e) {
      console.warn('⚠️ 過去データの読み込み失敗。新規データとして処理します。');
    }
  }

  const timestamp = getJstTimestamp();

  // 比較対象は直近の最新データ（historyの先頭要素）
  const oldData = history.length > 0 ? history[0] : [];
  const diffs = compareData(oldData, newData);

  await sendToGAS(timestamp, diffs, newData);

  // --- 最新データを先頭に追加し、過去3回分のみ残して保存 ---
  history.unshift(newData);
  history = history.slice(0, 3);

  fs.writeFileSync(DATA_FILE, JSON.stringify(history, null, 2), 'utf-8');
  console.log(`=== 全処理完了（過去${history.length}回分の履歴を保存） ===`);
})();
