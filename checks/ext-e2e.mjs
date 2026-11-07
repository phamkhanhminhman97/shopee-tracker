import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { chromePath } from './chrome.mjs';

const EXT = fileURLToPath(new URL('../extension/', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'shopee-extension-'));
const key = join(tmp, 'key.pem');
const cert = join(tmp, 'cert.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-days', '1', '-keyout', key, '-out', cert], { stdio: 'ignore' });
const fixture = readFileSync(new URL('../tests/fixtures/cart.html', import.meta.url), 'utf8');
const state = { captcha: false, partial: false, unavailable: false, posts: [], cartHits: 0 };
const cartPage = () => state.partial
  ? fixture.replace('<!--partial-->', '<div><h4>cart_accessibility_item</h4><a href="/vi-i.222.2002">Ví mẫu</a><div>19.000₫</div></div>' +
      '<div><h4>cart_accessibility_item</h4><p>Không có giá hoặc liên kết</p></div>')
  : fixture;

const server = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
  const host = (req.headers.host || '').split(':')[0];
  const url = new URL(req.url, 'https://' + host);
  if (host === 'shopee.vn' && url.pathname === '/cart') {
    state.cartHits++;
    if (state.captcha) {
      res.writeHead(302, { location: '/verify/captcha?scene=crawler_item' });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(cartPage());
  }
  if (host === 'shopee.vn' && url.pathname.startsWith('/verify/')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><title>Verify</title><body>captcha</body>');
  }
  if (host === 'shopee.phamkhanhminhman.com' && url.pathname === '/api/sync/cart' && req.method === 'POST') {
    if (state.unavailable) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      return res.end('unavailable');
    }
    if (req.headers['x-shopee-tracker'] !== '1') {
      res.writeHead(403);
      return res.end();
    }
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      state.posts.push(parsed);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, run: { totalInCart: parsed.items.length, changedCount: parsed.items.length }, alertsSent: 0 }));
    });
    return;
  }
  res.writeHead(404);
  res.end('not found');
}).listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); };

let browser;
try {
  browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    pipe: true,
    enableExtensions: [EXT],
    args: ['--ignore-certificate-errors', '--no-first-run', '--no-proxy-server', '--host-resolver-rules=MAP shopee.vn 127.0.0.1:' + port + ',MAP shopee.phamkhanhminhman.com 127.0.0.1:' + port + ',MAP *.susercontent.com ~NOTFOUND'],
  });

  const target = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 15000 });
  const worker = await target.worker();

  // 1. Lượt quét thủ công trên giỏ hàng nạp dần
  const r1 = await worker.evaluate(() => scanCart('manual'));
  check('manual scan ok', r1.ok === true, JSON.stringify(r1));
  const post1 = state.posts[0];
  const items = (post1 && post1.items) || [];
  check('sync nhận 3 món đang bán (bỏ mục inactive)', items.length === 3, 'got ' + items.length);
  const byId = Object.fromEntries(items.map(i => [i.itemId, i]));
  check('giá Live đọc đúng', byId['1001'] && byId['1001'].unitPrice === 529000 && byId['1001'].streamingPrice === 398000, JSON.stringify(byId['1001']));
  check('tên shop bỏ nhãn Mall', byId['1001'] && byId['1001'].shopName === 'Gian A', byId['1001'] && byId['1001'].shopName);
  check('tên shop bỏ nhãn Preferred Seller Plus', byId['2001'] && byId['2001'].shopName === 'Gian B', byId['2001'] && byId['2001'].shopName);
  check('giá gạch ngang không bị nhận làm giá hiện hành', byId['2001'] && byId['2001'].unitPrice === 199000, JSON.stringify(byId['2001']));
  check('phân loại', byId['1002'] && byId['1002'].variation === 'Đen', byId['1002'] && byId['1002'].variation);
  check('voucher shop', byId['1001'] && /60k/.test(byId['1001'].voucherHint), byId['1001'] && byId['1001'].voucherHint);
  check('flash sale và nhãn rẻ hơn từ lúc thêm giỏ', byId['1001'].flashSaleText.includes('Flash Sale') && byId['1002'].cartDropBadge.includes('cheaper'), '');
  check('mục inactive bị bỏ', !byId['3001'], '');

  state.partial = true;
  const partial = await worker.evaluate(() => scanCart('manual'));
  check('không gửi khi chỉ đọc được 4/5 món', !partial.ok && partial.error.includes('4/5') && state.posts.length === 1, partial);
  state.partial = false;
  state.unavailable = true;
  const networkError = await worker.evaluate(() => scanCart('alarm'));
  const retryAlarm = await worker.evaluate(() => chrome.alarms.get('shopee-cart-retry'));
  check('HTTP 503 có thông báo và đặt lịch thử lại', !networkError.ok && networkError.error.includes('503') && !!retryAlarm, networkError);
  state.unavailable = false;
  const retry = await worker.evaluate(() => scanCart('retry'));
  check('thử lại thành công và xoá lịch cũ', retry.ok && !(await worker.evaluate(() => chrome.alarms.get('shopee-cart-retry'))), retry);

  // 2. CAPTCHA: dừng tự động, không gửi gì lên máy chủ
  state.captcha = true;
  const postsBefore = state.posts.length;
  const r2 = await worker.evaluate(() => scanCart('manual'));
  check('captcha được nhận diện', r2.ok === false && /xác minh/.test(r2.error), JSON.stringify(r2));
  const hitsAfterCaptcha = state.cartHits;
  const r3 = await worker.evaluate(() => scanCart('alarm'));
  check('quét tự động bị chặn khi còn captcha', r3.ok === false && /tạm dừng/.test(r3.error), JSON.stringify(r3));
  check('quét tự động không tải lại giỏ hàng', state.cartHits === hitsAfterCaptcha, state.cartHits + ' vs ' + hitsAfterCaptcha);
  check('captcha không gửi dữ liệu lên máy chủ', state.posts.length === postsBefore, '');

  // 3. Hết captcha: quét thủ công mở lại
  state.captcha = false;
  const r4 = await worker.evaluate(() => scanCart('manual'));
  check('quét thủ công thành công sau captcha', r4.ok === true, JSON.stringify(r4));
  const r5 = await worker.evaluate(() => scanCart('alarm'));
  check('quét tự động hoạt động lại', r5.ok === true, JSON.stringify(r5));

  // 4. Cửa sổ nhỏ của tiện ích
  const extId = new URL(target.url()).host;
  const popup = await browser.newPage();
  const popupErrors = [];
  popup.on('pageerror', e => popupErrors.push(String(e)));
  popup.on('console', m => { if (m.type() === 'error') popupErrors.push(m.text()); });
  await popup.goto('chrome-extension://' + extId + '/popup.html');
  await popup.waitForFunction(() => document.getElementById('status').className === 'ok', { timeout: 5000 });
  const shown = await popup.$eval('#status', e => e.textContent);
  check('popup hiện lượt đồng bộ gần nhất', /Đã đồng bộ 3 món lúc \d\d\/\d\d \d\d:\d\d/.test(shown), shown);
  check('popup hiển thị mặc định 4 giờ', await popup.$eval('#interval', e => e.value) === '4', '');
  await worker.evaluate(() => { running = true; });
  try {
    await popup.click('#scan');
    await popup.waitForFunction(() => !document.getElementById('scan').disabled);
    const busy = await popup.$eval('#status', el => el.textContent);
    check('popup báo đang bận thay vì hiện kết quả lần trước', busy.includes('lượt quét chạy dở'), busy);
  } finally {
    await worker.evaluate(() => { running = false; });
  }
  await popup.select('#interval', '6');
  await new Promise(r => setTimeout(r, 600));
  const alarm = await worker.evaluate(() => chrome.alarms.get('shopee-cart-sync'));
  check('đổi chu kỳ sang 6 giờ cập nhật báo thức', alarm && alarm.periodInMinutes === 360, JSON.stringify(alarm));
  const postsBeforePopupScan = state.posts.length;
  await popup.click('#scan');
  await popup.waitForFunction(() => !document.getElementById('scan').disabled, { timeout: 30000 });
  check('nút Quét giỏ hàng ngay trong popup chạy xong và gửi dữ liệu', state.posts.length === postsBeforePopupScan + 1 && (await popup.$eval('#status', e => e.className)) === 'ok', state.posts.length);
  check('popup không lỗi console', popupErrors.length === 0, popupErrors);
} catch (err) {
  check('chạy kiểm thử không lỗi', false, String(err && err.stack || err));
} finally {
  await browser?.close();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
  console.log(JSON.stringify(checks, null, 2));
  console.log(checks.every(c => c.ok) ? 'ALL_PASS' : 'HAS_FAIL');
  process.exitCode = checks.every(c => c.ok) ? 0 : 1;
}

