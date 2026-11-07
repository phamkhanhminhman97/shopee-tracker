import puppeteer from 'puppeteer-core';
import { chromePath } from './chrome.mjs';
const URL_BASE = 'https://shopee.phamkhanhminhman.com/';
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: ok ? undefined : detail });

const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ['--no-first-run'] });
const page = await browser.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));
page.on('requestfailed', r => errors.push('requestfailed ' + r.url()));

for (const [w, h, theme] of [[1440, 900, 'dark'], [1024, 800, 'dark'], [768, 900, 'light'], [390, 844, 'light'], [390, 844, 'dark']]) {
  await page.setViewport({ width: w, height: h });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
  await page.goto(URL_BASE, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.row');
  const m = await page.evaluate(() => {
    const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none'; };
    const small = [...document.querySelectorAll('button, a[href], select, input:not([type=checkbox])')].filter(vis).filter(el => !el.classList.contains('skip')).filter(el => { const r = el.getBoundingClientRect(); return r.height < 44 || r.width < 44; }).length;
    const imgs = [...document.querySelectorAll('img')].filter(i => { const r = i.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; });
    return { rows: document.querySelectorAll('.row').length, overflow: document.documentElement.scrollWidth > innerWidth, small, imgsOk: imgs.every(i => i.complete && i.naturalWidth > 0), meta: document.getElementById('sync-meta').textContent, worth: document.getElementById('count-worth').textContent, cart: document.getElementById('count-cart').textContent };
  });
  check(w + 'px ' + theme + ': danh sách có sản phẩm, không tràn, vùng chạm đủ, ảnh tải được', m.rows > 0 && !m.overflow && m.small === 0 && m.imgsOk, m);
  if (w === 1440) {
    console.log('meta:', m.meta, '| giỏ hàng', m.cart, '| đáng chốt', m.worth);
  }
}

await page.setViewport({ width: 1440, height: 900 });
await page.goto(URL_BASE, { waitUntil: 'networkidle0' });
await page.waitForSelector('.row');
await page.click('[data-view="worth"]');
check('tab Đáng chốt hiển thị đúng số dòng', (await page.$$eval('.row', r => r.length)) === Number(await page.$eval('#count-worth', e => e.textContent)), '');
await page.click('[data-view="cart"]');
await page.click('.row [data-open]');
await page.waitForSelector('#inspector #chart svg');
check('bảng chi tiết desktop có biểu đồ', !(await page.$eval('#dialog', el => el.open)), '');
await page.setViewport({ width: 390, height: 844 });
await page.goto(URL_BASE, { waitUntil: 'networkidle0' });
await page.waitForSelector('.row');
await page.click('.row [data-open]');
await page.waitForSelector('#dialog[open] #chart svg');
check('ngăn chi tiết mở trên màn hình hẹp', true, '');
await page.keyboard.press('Escape');
await page.click('#connect-toggle');
const connect = await page.$eval('#connect', el => ({ telegram: !el.querySelector('#telegram-test').disabled, rows: el.querySelectorAll('tbody tr').length, steps: !!el.querySelector('.steps'), firstSource: el.querySelector('tbody td:nth-child(2)')?.textContent }));
check('tab Kết nối: Telegram bật và có nhật ký quét', connect.telegram && connect.rows >= 1, connect);
const zip = (await fetch(URL_BASE + 'extension/shopee-cart-sync.zip')).status;
const font = await fetch(URL_BASE + 'fonts/Geist-400-latin.woff2');
check('phông Geist được phục vụ (200, font/woff2)', font.status === 200 && /woff2/.test(font.headers.get('content-type') || ''), [font.status, font.headers.get('content-type')]);
await page.setViewport({ width: 1440, height: 900 });
await page.goto(URL_BASE, { waitUntil: 'networkidle0' });
await page.waitForSelector('.row');
const fam = await page.evaluate(async () => { await document.fonts.ready; return { loaded: [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family + ' ' + f.weight), body: getComputedStyle(document.body).fontFamily, themeBtn: !!document.getElementById('theme-btn') }; });
check('Geist đã tải và đang dùng, không còn nút chủ đề', fam.loaded.some(f => f.startsWith('Geist')) && /Geist/.test(fam.body) && !fam.themeBtn, fam);
const tn = await page.$$eval('img.thumb', els => els.every(e => e.getAttribute('src').endsWith('_tn')));
check('ảnh dùng bản _tn', tn, '');
check('gói .zip cũ không còn được phục vụ', zip === 404, zip);
check('0 lỗi console, 0 request hỏng', errors.length === 0, errors.slice(0, 5));

await browser.close();
for (const c of checks) console.log((c.ok ? 'PASS ' : 'FAIL ') + c.name + (c.ok ? '' : ' :: ' + JSON.stringify(c.detail)));
console.log(checks.every(c => c.ok) ? 'ALL_PASS' : 'HAS_FAIL');
process.exitCode = checks.every(c => c.ok) ? 0 : 1;

