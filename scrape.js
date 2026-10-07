const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const GAS_WEBAPP_URL = process.env.GAS_WEBAPP_URL;
const DATA_FILE = path.join(__dirname, 'data.json');
const CONCURRENCY = 2;

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
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
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

      // 1. 最優先: .price-original クラス内の価格要素を取得（特売あり・なし共通）
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
        
        // .notranslate がない場合は .price-original 内の「¥」を含むテキストから抽出
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

      // 2. 第2候補: 「オンライン価格」ラベルを持つ要素の周辺から探索（従来のバックアップ）
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
          if (text.match(/^[¥￥]?[0-9,]+$/)) {
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

    console.log(`  └
