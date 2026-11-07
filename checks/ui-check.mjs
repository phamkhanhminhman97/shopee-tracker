import puppeteer from 'puppeteer-core';

const URL_BASE = process.argv[2] || 'http://127.0.0.1:8788/';
const OUT = '/private/tmp/ui-shots';
import { mkdirSync } from 'node:fs';
mkdirSync(OUT, { recursive: true });

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: ok ? undefined : detail });

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--no-first-run'],
});
const page = await browser.newPage();
const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push(String(e)));

async function open(width, height, theme) {
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
  await page.goto(URL_BASE, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.row', { timeout: 10000 });
}

async function metrics() {
  return page.evaluate(() => {
    const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const controls = [...document.querySelectorAll('button, a[href], select, input:not([type=checkbox])')].filter(el => visible(el) && !el.classList.contains('skip'));
    const small = controls.map(el => ({ tag: el.tagName, text: (el.textContent || el.id || '').trim().slice(0, 24), w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) })).filter(c => c.h < 44 || c.w < 44);
    const imgs = [...document.querySelectorAll('img')].filter(img => { const r = img.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; });
    return {
      overflow: document.documentElement.scrollWidth > innerWidth,
      small,
      rows: document.querySelectorAll('.row').length,
      imgsOk: imgs.every(i => i.complete && i.naturalWidth > 0),
      imgCount: imgs.length,
      h1: document.querySelectorAll('h1').length,
      lang: document.documentElement.lang,
    };
  });
}

for (const [w, h] of [[1440, 900], [1024, 800], [768, 900], [390, 844]]) {
  await open(w, h, 'light');
  const m = await metrics();
  check(w + 'px: không tràn ngang', !m.overflow, m);
  check(w + 'px: mọi nút, liên kết, ô nhập cao rộng từ 44px', m.small.length === 0, m.small.slice(0, 4));
  check(w + 'px: ảnh trong màn hình tải được', m.imgsOk && m.imgCount > 0, m);
  check(w + 'px: có 25 dòng, một h1, lang vi', m.rows === 25 && m.h1 === 1 && m.lang === 'vi', m);
  await page.screenshot({ path: OUT + '/light-' + w + '.png' });
}

// Chế độ tối ở hai độ rộng
for (const [w, h] of [[1440, 900], [390, 844]]) {
  await open(w, h, 'dark');
  const m = await metrics();
  check('tối ' + w + 'px: không tràn ngang và vùng chạm đủ', !m.overflow && m.small.length === 0, m);
  await page.screenshot({ path: OUT + '/dark-' + w + '.png' });
}

// Tương tác ở 1440 (sáng)
await open(1440, 900, 'light');
const count = () => page.$$eval('.row', r => r.length);

await page.type('#search', 'Vinamilk');
const vina = await count();
check('tìm "Vinamilk" lọc đúng (11 dòng)', vina === 11, vina);
await page.$eval('#search', el => { el.value = ''; });
await page.type('#search', 'zzz-khong-co');
check('tìm không thấy: hiện trạng thái rỗng có nút xoá', !!(await page.$('[data-action="clear-search"]')) && (await count()) === 0, '');
await page.click('[data-action="clear-search"]');
check('xoá tìm kiếm: về 25 dòng', (await count()) === 25, await count());

await page.select('#sort', 'price');
const firstPrice = await page.$eval('.row .price', el => Number(el.textContent.replace(/\D/g, '')));
const allPrices = await page.$$eval('.row .price', els => els.map(el => Number(el.textContent.replace(/\D/g, ''))));
check('sắp xếp giá thấp đến cao', allPrices.every((p, i) => i === 0 || allPrices[i - 1] <= p) && firstPrice === Math.min(...allPrices), allPrices.slice(0, 5));
await page.select('#sort', 'deal');
const firstWorth = await page.$eval('.row', el => el.classList.contains('is-worth'));
check('sắp xếp ưu tiên giá tốt: dòng đầu là món đáng chốt', firstWorth, '');

await page.click('[data-view="worth"]');
const worthRows = await count();
const worthBadge = await page.$eval('#count-worth', el => Number(el.textContent));
check('tab Đáng chốt khớp số đếm', worthRows === worthBadge && worthRows === 4, { worthRows, worthBadge });
await page.click('[data-view="cart"]');

// Hộp chi tiết
await page.click('.row [data-open]');
await page.waitForSelector('#dialog[open]');
await page.waitForSelector('#chart svg');
const chartInfo = await page.$eval('#chart', el => ({ circles: el.querySelectorAll('circle').length, paths: el.querySelectorAll('path').length }));
check('hộp chi tiết mở và vẽ biểu đồ', chartInfo.circles >= 1, chartInfo);
await page.screenshot({ path: OUT + '/dialog-1440.png' });
const presetCount = await page.$$eval('#presets [data-preset]', b => b.length);
await page.click('#presets [data-preset]');
const targetVal = await page.$eval('#target', el => el.value);
check('3 mức gợi ý điền vào ô giá canh', presetCount === 3 && /^\d+$/.test(targetVal), { presetCount, targetVal });
await page.click('#save');
await page.waitForFunction(() => document.querySelector('#dialog-feedback')?.textContent.includes('Đã lưu'));
check('lưu giá canh báo thành công', true, '');
await page.keyboard.press('Escape');
await page.waitForFunction(() => !document.querySelector('#dialog').open);
const focusBack = await page
  .waitForFunction(() => document.activeElement?.hasAttribute('data-open'), { timeout: 2000 })
  .then(() => true, () => false);
check('Esc đóng hộp và trả focus về nút mở', focusBack, '');
const targetChip = await page.$$eval('.chip', els => els.some(e => /giá canh/i.test(e.textContent)));
check('dòng hiện chip giá canh sau khi lưu', targetChip, '');

// Dọn giá canh vừa đặt để không để lại dữ liệu thử
await page.click('.row [data-open]');
await page.waitForSelector('#dialog[open]');
await page.$eval('#target', el => { el.value = ''; });
await page.click('#save');
await page.waitForFunction(() => document.querySelector('#dialog-feedback')?.textContent.includes('Đã lưu'));
await page.keyboard.press('Escape');

// Giá trị sai bị từ chối
await page.click('.row [data-open]');
await page.waitForSelector('#dialog[open]');
await page.type('#target', 'abc');
await page.click('#save');
const bad = await page.$eval('#dialog-feedback', el => el.textContent);
check('giá canh sai bị báo lỗi tại chỗ', /hợp lệ/.test(bad), bad);
await page.keyboard.press('Escape');

// Chủ đề theo hệ điều hành
const bg = async t => { await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: t }]); return page.evaluate(() => getComputedStyle(document.body).backgroundColor); };
const darkBg = await bg('dark');
const lightBg = await bg('light');
check('chủ đề theo prefers-color-scheme: tối #181818, sáng #F5F5F5', darkBg === 'rgb(24, 24, 24)' && lightBg === 'rgb(245, 245, 245)', { darkBg, lightBg });
check('không còn nút chuyển chủ đề', !(await page.$('#theme-btn')), '');

// Tab Kết nối
await page.click('[data-view="connect"]');
const connect = await page.$eval('#connect', el => ({ hidden: el.hidden, hasTelegram: !!el.querySelector('#telegram-test'), rows: el.querySelectorAll('tbody tr').length, setup: !!el.querySelector('.steps') }));
check('tab Kết nối: có Telegram, bảng 3 lượt quét, không hiện hướng dẫn gắn tiện ích', !connect.hidden && connect.hasTelegram && connect.rows === 3 && !connect.setup, connect);
const testDisabled = await page.$eval('#telegram-test', el => el.disabled);
check('nút gửi tin thử bị khoá khi chưa cấu hình Telegram', testDisabled === true, testDisabled);
await page.screenshot({ path: OUT + '/connect-1440.png' });
await page.click('[data-view="cart"]');

// Phím /
await page.evaluate(() => document.activeElement && document.activeElement.blur());
await page.keyboard.press('/');
check('phím / đưa focus vào ô tìm', (await page.evaluate(() => document.activeElement?.id)) === 'search', '');

// Điện thoại: cuộn tới dòng cuối vẫn thấy đủ nút
await page.setViewport({ width: 390, height: 844 });
const lastRow = await page.evaluate(() => { const r = [...document.querySelectorAll('.row')].pop().getBoundingClientRect(); return { fits: r.width <= innerWidth }; });
check('390px: dòng cuối nằm gọn trong màn hình', lastRow.fits, lastRow);

check('0 lỗi console (gồm vi phạm CSP)', consoleErrors.length === 0, consoleErrors.slice(0, 5));


// ---- Ảnh thu nhỏ ----
await open(1440, 900, 'dark');
const srcs = await page.$$eval('img.thumb', els => els.map(e => e.getAttribute('src')));
check('ảnh dùng bản _tn (25/25)', srcs.length === 25 && srcs.every(s => s.endsWith('_tn')), srcs.slice(0, 2));

// ---- Trạng thái đang tải, lỗi, rỗng, quá hạn (chặn /api/state) ----
async function withState(handler, fn) {
  const p2 = await browser.newPage();
  await p2.setViewport({ width: 1440, height: 900 });
  await p2.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await p2.setRequestInterception(true);
  p2.on('request', req => (req.url().includes('/api/state') ? handler(req) : req.continue()));
  try { await fn(p2); } finally { await p2.close(); }
}
const json = body => req => req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

await withState(req => setTimeout(() => req.continue(), 1500), async p2 => {
  await p2.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
  await p2.waitForSelector('.sk-row');
  const sk = await p2.$$eval('.sk-row', r => r.length);
  await p2.screenshot({ path: OUT + '/state-loading.png' });
  check('đang tải: 6 dòng khung xương', sk === 6, sk);
  await p2.waitForSelector('.row');
});
await withState(req => req.abort(), async p2 => {
  await p2.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
  await p2.waitForSelector('.empty[role="alert"]');
  const retry = !!(await p2.$('[data-action="retry"]'));
  await p2.screenshot({ path: OUT + '/state-error.png' });
  check('lỗi mạng: hiện thông báo và nút Tải lại', retry, '');
});
await withState(json({ items: [], recentRuns: [], lastSyncedAt: null, telegramConfigured: false }), async p2 => {
  await p2.goto(URL_BASE, { waitUntil: 'networkidle0' });
  await p2.waitForSelector('[data-action="connect"]');
  await p2.screenshot({ path: OUT + '/state-empty.png' });
  await p2.click('[data-action="connect"]');
  const steps = await p2.$$eval('.steps li', l => l.length);
  await p2.screenshot({ path: OUT + '/state-setup.png' });
  check('sổ rỗng: nút dẫn tới hướng dẫn gắn tiện ích (3 bước)', steps === 3, steps);
});
const stale = new Date(Date.now() - 10 * 3600_000).toISOString();
const state = await (await fetch(URL_BASE + 'api/state')).json();
await withState(json({ ...state, lastSyncedAt: stale }), async p2 => {
  await p2.goto(URL_BASE, { waitUntil: 'networkidle0' });
  await p2.waitForSelector('.row');
  const info = await p2.$eval('#sync-meta', el => ({ cls: el.className, hasIcon: !!el.querySelector('svg'), text: el.textContent }));
  await p2.screenshot({ path: OUT + '/state-stale.png', clip: { x: 0, y: 0, width: 1440, height: 160 } });
  check('quá 8 giờ chưa đồng bộ: cảnh báo có biểu tượng và chữ', info.cls.includes('is-stale') && info.hasIcon && /giờ chưa đồng bộ/.test(info.text), info);
});

// ---- Giảm chuyển động ----
{
  const p3 = await browser.newPage();
  await p3.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await p3.goto(URL_BASE, { waitUntil: 'networkidle0' });
  await p3.waitForSelector('.row');
  await p3.click('.row [data-open]');
  await p3.waitForSelector('#dialog[open]');
  const dur = await p3.$eval('#dialog', el => getComputedStyle(el).animationDuration);
  check('giảm chuyển động: hộp thoại không chạy hiệu ứng', parseFloat(dur) < 0.001, dur);
  await p3.close();
}

await browser.close();
for (const c of checks) console.log((c.ok ? 'PASS ' : 'FAIL ') + c.name + (c.ok ? '' : ' :: ' + JSON.stringify(c.detail)));
console.log(checks.every(c => c.ok) ? 'ALL_PASS' : 'HAS_FAIL');

