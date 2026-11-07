import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import puppeteer from 'puppeteer-core';
import { chromePath } from './chrome.mjs';

const dist = resolve('dist');
const headers = await readFile(resolve(dist, '_headers'), 'utf8');
const csp = headers.match(/^\s*Content-Security-Policy: (.+)$/m)[1];
const syncedAt = new Date().toISOString();
const fixture = {
  cartKey: '1:2:trắng', shopId: '1', itemId: '2', shopName: 'Shop thử',
  title: 'Tai nghe đang giảm giá Live', variation: 'Trắng', productUrl: 'https://shopee.vn/product/1/2',
  imageUrl: '/broken-image.png', cartOrder: 0, unitPrice: 529_000, streamingPrice: 398_000, effectivePrice: 398_000,
  firstEffectivePrice: 499_000, minEffectivePrice: 398_000, firstUnitPrice: 529_000, minUnitPrice: 529_000,
  targetPrice: null, voucherHint: 'Up to 60k₫ off voucher available', flashSaleText: '', cartDropBadge: '', alertMuted: false, firstSeenAt: syncedAt,
};
const state = {
  items: [fixture, ...Array.from({ length: 17 }, (_, i) => ({
    ...fixture, cartKey: '1:2:phân loại ' + i, variation: 'Phân loại ' + i, cartOrder: i + 1,
    imageUrl: '', streamingPrice: null, effectivePrice: 529_000, minEffectivePrice: 529_000,
  }))], lastSyncedAt: syncedAt, telegramConfigured: false,
  recentRuns: [{ syncedAt, source: 'chrome-manual', totalInCart: 1, changedCount: 0, alertsSent: 0, note: '' }],
};
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
let sentHeader;
let pausePatch;
let noHistory = false;
const server = http.createServer(async (req, res) => {
  if (req.url === '/broken-image.png') return res.writeHead(200, { 'content-type': 'image/png' }).end('not an image');
  if (req.url.startsWith('/api/')) {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'PATCH') {
      sentHeader = req.headers['x-shopee-tracker'];
      let body = '';
      for await (const chunk of req) body += chunk;
      await pausePatch?.();
      fixture.targetPrice = JSON.parse(body).targetPrice;
      return res.end('{"ok":true}');
    }
    return res.end(JSON.stringify(req.url === '/api/state' ? state : { points: noHistory ? [] : [
      { recordedAt: '2026-11-06T00:00:00.000Z', unitPrice: 529_000, effectivePrice: 499_000 },
      { recordedAt: '2026-11-06T01:00:00.000Z', unitPrice: 529_000, effectivePrice: 440_000 },
      { recordedAt: '2026-11-07T00:00:00.000Z', unitPrice: 529_000, effectivePrice: 398_000 },
    ] }));
  }
  const path = resolve(dist, '.' + (req.url === '/' ? '/index.html' : req.url));
  if (!path.startsWith(dist + sep)) return res.writeHead(404).end();
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': mime[extname(path)] ?? 'application/octet-stream', 'content-security-policy': csp });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(0, '127.0.0.1');
await once(server, 'listening');

let browser;
try {
  browser = await puppeteer.launch({ executablePath: chromePath, headless: true });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    const interval = window.setInterval.bind(window);
    const realNow = Date.now;
    let offset = 0;
    Date.now = () => realNow() + offset;
    window.setInterval = (fn, ms, ...args) => {
      if (ms === 5 * 60_000) window.runRefresh = () => { offset += ms; fn(...args); };
      return interval(fn, ms, ...args);
    };
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const address = 'http://127.0.0.1:' + server.address().port + '/';
  const manifest = await (await fetch(address + 'manifest.webmanifest')).json();
  const pngSize = async path => {
    const image = Buffer.from(await (await fetch(new URL(path, address))).arrayBuffer());
    assert.equal(image.subarray(1, 4).toString(), 'PNG');
    return image.readUInt32BE(16) + 'x' + image.readUInt32BE(20);
  };
  assert.deepEqual(manifest.icons.map(icon => icon.sizes), ['192x192', '512x512', '512x512']);
  assert.equal(manifest.icons[2].purpose, 'maskable');
  for (const icon of manifest.icons) assert.equal(await pngSize(icon.src), icon.sizes);
  for (const [width, height] of [[320, 700], [390, 844], [768, 820], [844, 390], [1440, 900]]) {
    await page.setViewport({ width, height });
    await page.goto(address);
    await page.waitForSelector('.row');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Tràn ngang ở ' + width);
    if (width === 844) assert.equal(await page.$eval('.bar', el => getComputedStyle(el).position), 'static');
    const layout = await page.evaluate(() => {
      const [first, second] = document.querySelectorAll('.row');
      const box = (row, selector) => row.querySelector(selector).getBoundingClientRect();
      const prices = [first, second].map(row => box(row, '.price-box'));
      const button = box(first, '.row-open');
      const controls = [...document.querySelectorAll('#ledger-toolbar button, #ledger-toolbar input, #ledger-toolbar select, .row:first-child button, .row:first-child a')];
      const touchTargets = controls.every(el => {
        const rect = el.getBoundingClientRect();
        return rect.width >= 44 && rect.height >= 44;
      });
      return {
        samePriceColumn: Math.abs(prices[0].right - prices[1].right) < 1,
        priceBesideAction: prices[0].bottom >= button.top && prices[0].top <= button.bottom && prices[0].right <= button.left,
        touchTargets,
      };
    });
    assert.ok(layout.samePriceColumn && layout.priceBesideAction && layout.touchTargets, 'Giá và thao tác lệch ở ' + width);
  }
  assert.equal(await pngSize(await page.$eval('link[rel="apple-touch-icon"]', el => el.href)), '180x180');
  await page.waitForSelector('.row:first-child span.thumb');

  await page.evaluate(() => {
    const row = document.querySelectorAll('.row')[12];
    row.scrollIntoView({ block: 'start' });
    row.querySelector('[data-open]').focus({ preventScroll: true });
  });
  for (let i = 0; i < 4; i++) {
    await page.keyboard.down('Shift');
    await page.keyboard.press('Tab');
    await page.keyboard.up('Shift');
    const focusVisible = await page.evaluate(() =>
      document.activeElement.getBoundingClientRect().top >= document.querySelector('.bar').getBoundingClientRect().bottom
    );
    assert.equal(focusVisible, true, 'Thanh đầu trang không được che focus khi Shift+Tab');
  }

  await page.setViewport({ width: 320, height: 700 });
  await page.click('[data-open]');
  await page.waitForFunction(() => document.querySelector('#chart svg')?.getAttribute('aria-label').includes('499.000'));
  assert.match(await page.$eval('#product-notes', el => el.textContent), /Voucher shop giảm đến 60k₫/);
  const chart = await page.$eval('#chart svg', el => ({ width: el.clientWidth, view: el.viewBox.baseVal.width }));
  assert.equal(chart.width, chart.view, 'Biểu đồ không được thu chữ theo viewBox desktop');
  assert.match(await page.$eval('#chart-range', el => el.textContent), /398\.000.+499\.000/);
  const xs = await page.$$eval('#chart circle', nodes => nodes.map(node => Number(node.getAttribute('cx'))));
  assert.ok(Math.abs((xs[1] - xs[0]) / (xs[2] - xs[0]) - 1 / 24) < 0.005, 'Điểm cách một giờ phải gần hơn điểm cách 23 giờ');
  assert.equal(await page.$$eval('[data-preset]', els => els.length === 3 && els.every(el => Number(el.dataset.preset) < 398_000)), true);
  const target = await page.$('#target');
  const box = await target.boundingBox();
  await page.mouse.move(box.x + 15, box.y + 15);
  await page.mouse.down();
  await page.mouse.move(1, 1);
  await page.mouse.up();
  assert.equal(await page.$eval('#dialog', el => el.open), true, 'Kéo chọn chữ không được đóng hộp');
  await page.type('#target', '350k');
  await page.click('#save');
  await page.waitForFunction(() => document.querySelector('#dialog-feedback').textContent.includes('350.000'));
  assert.equal(fixture.targetPrice, 350_000);
  assert.equal(sentHeader, '1');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement.hasAttribute('data-open'));

  const patchStarted = Promise.withResolvers();
  const patchDone = Promise.withResolvers();
  pausePatch = () => { patchStarted.resolve(); return patchDone.promise; };
  try {
    await page.click('.row:first-child [data-open]');
    await page.$eval('#target', el => { el.value = '345k'; });
    await page.click('#save');
    await patchStarted.promise;
    await page.keyboard.press('Escape');
    await page.waitForSelector('#dialog', { hidden: true });
    await page.click('.row:nth-child(2) [data-open]');
    assert.equal(await page.$eval('#save', el => el.disabled), false, 'Lượt lưu chậm của món trước không khóa món đang mở');
    const oldRow = await page.$('.row:first-child');
    patchDone.resolve();
    await page.waitForFunction(row => !row.isConnected, {}, oldRow);
    assert.equal(await page.$eval('#dialog-feedback', el => el.textContent), '', 'Không hiển thị phản hồi lưu của món trước');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#dialog', { hidden: true });
    await page.focus('.row:first-child [data-open]');
  } finally {
    patchDone.resolve();
    pausePatch = undefined;
  }

  noHistory = true;
  await page.click('.row:first-child [data-open]');
  await page.waitForFunction(() => document.querySelector('#chart-range')?.textContent === 'Chưa có lịch sử giá.');
  assert.equal(await page.$('#chart svg'), null);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#dialog', { hidden: true });
  await page.focus('.row:first-child [data-open]');
  noHistory = false;

  fixture.title = 'Tên món sau lần cập nhật';
  await page.evaluate(() => window.runRefresh());
  await page.waitForFunction(() => document.querySelector('.row h2')?.textContent === 'Tên món sau lần cập nhật');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.open), fixture.cartKey);

  await page.click('[data-view="connect"]');
  assert.equal(await page.$eval('[data-view="connect"]', el => el.getAttribute('aria-pressed')), 'true');
  assert.ok(await page.$eval('.table-wrap', el => el.scrollWidth <= el.clientWidth), 'Nhật ký 320 px phải đọc được không cuộn ngang');

  await page.setViewport({ width: 320, height: 700, isMobile: true, hasTouch: true });
  await page.goto(address);
  await page.waitForSelector('.row');
  const keys = () => page.$$eval('.row', rows => rows.map(row => row.dataset.key));
  const initial = await keys();
  await page.tap('#edit-order');
  assert.equal(await page.$eval('#sort', el => el.value), 'manual');
  const moveDown = '.row:first-child button[data-move="down"]';
  assert.equal(await page.$eval(moveDown, el => el.getBoundingClientRect().width >= 44), true);
  await page.tap(moveDown);
  assert.deepEqual((await keys()).slice(0, 2), [initial[1], initial[0]]);
  const movedFocus = await page.evaluate(() => document.activeElement.closest('.row')?.dataset.key);
  assert.equal(movedFocus, initial[0]);
  await page.tap('#edit-order');
  await page.reload();
  await page.waitForSelector('.row');
  assert.equal(await page.$eval('#sort', el => el.value), 'manual');
  assert.deepEqual((await keys()).slice(0, 2), [initial[1], initial[0]]);

  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(address);
  await page.waitForSelector('.row');
  await page.click('#edit-order');
  await page.setDragInterception(true);
  const grip = await (await page.$('.row:first-child [data-grip]')).boundingBox();
  const destination = await (await page.$('.row:nth-child(3)')).boundingBox();
  assert.ok(grip && destination);
  await page.mouse.dragAndDrop(
    { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 },
    { x: destination.x + destination.width / 2, y: destination.y + destination.height * 0.75 },
  );
  assert.deepEqual((await keys()).slice(0, 3), [initial[0], initial[2], initial[1]]);
  await page.click('#edit-order');
  await page.select('#sort', 'cart');
  assert.deepEqual((await keys()).slice(0, 3), initial.slice(0, 3));
  await page.select('#sort', 'manual');
  assert.deepEqual((await keys()).slice(0, 3), [initial[0], initial[2], initial[1]]);

  assert.deepEqual(errors, []);
  console.log('PASS: 5 khung màn hình, trục thời gian, focus, nút đổi vị trí, kéo thả và thứ tự sau tải lại');
} finally {
  await browser?.close();
  server.close();
}
