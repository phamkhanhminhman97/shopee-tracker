const API_BASE = 'https://shopee.phamkhanhminhman.com';
const ALARM = 'shopee-cart-sync';
const RETRY_ALARM = 'shopee-cart-retry';
const DEFAULT_HOURS = 4;

let running = false;

async function intervalMinutes() {
  const { intervalHours } = await chrome.storage.local.get('intervalHours');
  return ([3, 4, 6].includes(intervalHours) ? intervalHours : DEFAULT_HOURS) * 60;
}

async function scheduleAlarm() {
  const minutes = await intervalMinutes();
  const alarm = await chrome.alarms.get(ALARM);
  if (alarm?.periodInMinutes !== minutes) {
    await chrome.alarms.create(ALARM, { periodInMinutes: minutes });
  }
}

async function clearRetry() {
  await chrome.alarms.clear(RETRY_ALARM);
  await chrome.storage.local.remove(['retryCount', 'retryAt']);
}

async function scheduleRetry() {
  const { retryCount = 0 } = await chrome.storage.local.get('retryCount');
  if (retryCount >= 3) return;
  const retryAt = Date.now() + 10 * 60_000;
  await chrome.storage.local.set({ retryCount: retryCount + 1, retryAt });
  await chrome.alarms.create(RETRY_ALARM, { when: retryAt });
}

function waitForLoad(tabId, timeoutMs = 25000) {
  return new Promise(resolve => {
    const timer = setTimeout(() => done(false), timeoutMs);
    function done(loaded) {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(loaded);
    }
    function onUpdated(id, info) {
      if (id === tabId && info.status === 'complete') done(true);
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then(tab => { if (tab.status === 'complete') done(true); }, () => done(false));
  });
}

async function saveStatus(status) {
  const at = Date.now();
  await chrome.storage.local.set({ lastStatus: { ...status, at }, ...(status.ok ? { lastOkAt: at } : {}) });
  await chrome.action.setBadgeText({ text: status.ok ? '' : '!' });
  if (!status.ok) await chrome.action.setBadgeBackgroundColor({ color: '#7A4212' });
  return status;
}

async function scanCart(source) {
  if (running) return { ok: false, error: 'Đang có lượt quét chạy dở.' };
  running = true;
  let tempTabId = null;
  let retryable = false;
  try {
    const { blocked } = await chrome.storage.local.get('blocked');
    if (source !== 'retry') await clearRetry();
    else await chrome.storage.local.remove('retryAt');
    if (blocked && source !== 'manual') {
      return { ok: false, error: 'Đã tạm dừng tự động vì Shopee yêu cầu xác minh. Hoàn tất xác minh rồi bấm Quét giỏ hàng ngay.' };
    }

    retryable = true;
    const tab = await chrome.tabs.create({ url: 'https://shopee.vn/cart', active: false });
    const tabId = tempTabId = tab.id;
    if (tabId === undefined || !await waitForLoad(tabId)) throw new Error('Không tải xong trang giỏ hàng.');
    retryable = false;
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content-scrape.js'] });
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.__scrapeShopeeCart(),
    });
    const scrape = injection && injection.result;
    if (!scrape || !scrape.ok) {
      if (scrape && scrape.blocked) {
        await chrome.storage.local.set({ blocked: true });
        await clearRetry();
        if (source === 'manual') tempTabId = null;
      }
      return saveStatus({ ok: false, error: (scrape && scrape.error) || 'Không đọc được giỏ hàng Shopee.' });
    }

    retryable = true;
    const response = await fetch(API_BASE + '/api/sync/cart', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shopee-tracker': '1' },
      signal: AbortSignal.timeout(25_000),
      body: JSON.stringify({ source: 'chrome-' + source, items: scrape.items, cartEmpty: scrape.cartEmpty }),
    });
    retryable = response.status >= 500 || response.status === 409 || response.status === 429;
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.ok) throw new Error(body?.error || 'HTTP ' + response.status);

    await chrome.storage.local.set({ blocked: false });
    await clearRetry();
    return saveStatus({ ok: true, total: body.run.totalInCart, changed: body.run.changedCount, alerts: body.alertsSent });
  } catch (err) {
    if (retryable) await scheduleRetry();
    return saveStatus({ ok: false, error: err instanceof Error ? err.message : String(err) });
  } finally {
    if (tempTabId !== null) chrome.tabs.remove(tempTabId).catch(() => {});
    running = false;
  }
}

chrome.runtime.onInstalled.addListener(scheduleAlarm);

// Máy ngủ hoặc Chrome tắt qua giờ hẹn: quét bù ngay khi Chrome mở lại.
chrome.runtime.onStartup.addListener(async () => {
  const { lastOkAt } = await chrome.storage.local.get('lastOkAt');
  if (Date.now() - (lastOkAt || 0) >= (await intervalMinutes()) * 60000) scanCart('startup');
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM) scanCart('alarm');
  if (alarm.name === RETRY_ALARM) scanCart('retry');
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.intervalHours) scheduleAlarm();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === 'SYNC_NOW') {
    scanCart('manual').then(sendResponse);
    return true;
  }
  return false;
});

void scheduleAlarm();
void (async () => {
  const { retryAt, blocked } = await chrome.storage.local.get(['retryAt', 'blocked']);
  if (retryAt && !blocked && !await chrome.alarms.get(RETRY_ALARM)) {
    await chrome.alarms.create(RETRY_ALARM, { when: Math.max(Date.now() + 30_000, retryAt) });
  }
})();
