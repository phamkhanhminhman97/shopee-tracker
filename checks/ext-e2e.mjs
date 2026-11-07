import https from 'node:https';
import { readFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const EXT = '/Users/man/Documents/minhman-workspace/websites/shopee-tracker/extension';
const fmt = n => n.toLocaleString('vi-VN') + '₫';
const state = { captcha: false, posts: [], cartHits: 0 };

function rowHtml(shopId, itemId, title, variation, price, opts = {}) {
  const href = '/' + encodeURIComponent(title) + '-i.' + shopId + '.' + itemId + '?xptdk=abc';
  const struck = opts.struck ? '<del>' + fmt(opts.struck) + '</del>' : '';
  const live = opts.live ? '<div>Streaming Price at ' + fmt(opts.live) + '</div>' : '';
  const flash = opts.flash ? '<div>Flash Sale ends at 17:00:00</div>' : '';
  const badge = opts.badge ? '<div>13% cheaper since added to cart</div>' : '';
  return '<div class="item"><h4>cart_accessibility_item</h4><input type="checkbox">' +
    '<a href="' + href + '"><img src="https://down-vn.img.susercontent.com/file/' + itemId + '" width="40" height="40"></a>' +
    '<a href="' + href + '">' + (opts.prefix || '') + title + '</a>' + flash + badge +
    '<div>Variations:</div><div>' + variation + '</div>' +
    '<div>' + struck + '</div><span>' + fmt(price) + '</span><span class="a11y-hidden">Total price: ' + fmt(price) + '</span>' + live +
    '<button>Delete</button></div>';
}

function cartPage() {
  const shopA = '<section><h3>Shop Section</h3><input type="checkbox"><a href="/baseusofficial?entryPoint=cart">MallBaseus Official Mall</a><div>' +
    rowHtml(111, 1001, 'Tai nghe Baseus BS2', 'Trắng', 529000, { live: 398000, flash: true }) +
    rowHtml(111, 1002, 'Tai nghe Baseus BP1', 'Đen', 539000, { badge: true }) +
    '</div><div>Up to 60k₫ off voucher available</div><button>More Vouchers</button></section>';
  const shopB = '<section><h3>Shop Section</h3><a href="/elmich?entryPoint=cart">Preferred Seller PlusElmich Việt Nam</a><div>' +
    rowHtml(222, 2001, 'Cốc giữ nhiệt Elmich', 'Xanh min', 199000, { struck: 259000 }) +
    '</div></section>';
  const inactive = '<section><h3>Number of inactive items: 1</h3><div><h4>cart_accessibility_item</h4><div>INVALID</div>' +
    '<a href="/x-i.333.3001"><img src="https://down-vn.img.susercontent.com/file/3001"></a><a href="/x-i.333.3001">Add-OnTúi Baseus mini</a>' +
    '<div>Variations:</div><div>Đen</div><span>' + fmt(57140) + '</span><button>Delete</button></div></section>';
  // Nạp dần để kiểm tra bước chờ số dòng ổn định.
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shopping Cart</title><style>.a11y-hidden{position:absolute;clip:rect(0 0 0 0);width:1px;height:1px;overflow:hidden}</style></head><body><div id="app"></div><script>' +
    'const parts=' + JSON.stringify([shopA, shopB, inactive]) + ';' +
    'const app=document.getElementById("app");' +
    'setTimeout(()=>{app.insertAdjacentHTML("beforeend",parts[0])},250);' +
    'setTimeout(()=>{app.insertAdjacentHTML("beforeend",parts[1]);app.insertAdjacentHTML("beforeend",parts[2])},1400);' +
    '</script></body></html>';
}

const server = https.createServer({ key: readFileSync('key.pem'), cert: readFileSync('cert.pem') }, (req, res) => {
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
}).listen(8443);

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); };

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  pipe: true,
  enableExtensions: [EXT],
  userDataDir: '/private/tmp/ext-e2e/profile-' + Date.now(),
  args: ['--ignore-certificate-errors', '--no-first-run', '--host-resolver-rules=MAP shopee.vn 127.0.0.1:8443,MAP shopee.phamkhanhminhman.com 127.0.0.1:8443'],
});

try {
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
  check('tên shop bỏ nhãn Mall', byId['1001'] && byId['1001'].shopName === 'Baseus Official Mall', byId['1001'] && byId['1001'].shopName);
  check('tên shop bỏ nhãn Preferred Seller Plus', byId['2001'] && byId['2001'].shopName === 'Elmich Việt Nam', byId['2001'] && byId['2001'].shopName);
  check('giá gạch ngang không bị nhận làm giá hiện hành', byId['2001'] && byId['2001'].unitPrice === 199000, JSON.stringify(byId['2001']));
  check('phân loại', byId['1002'] && byId['1002'].variation === 'Đen', byId['1002'] && byId['1002'].variation);
  check('voucher shop', byId['1001'] && /60k/.test(byId['1001'].voucherHint), byId['1001'] && byId['1001'].voucherHint);
  check('flash sale và nhãn rẻ hơn từ lúc thêm giỏ', byId['1001'].flashSaleText.includes('Flash Sale') && byId['1002'].cartDropBadge.includes('cheaper'), '');
  check('mục inactive bị bỏ', !byId['3001'], '');

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
  await browser.close();
  server.close();
  console.log(JSON.stringify(checks, null, 2));
  console.log(checks.every(c => c.ok) ? 'ALL_PASS' : 'HAS_FAIL');
  process.exit(0);
}

