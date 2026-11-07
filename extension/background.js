const API_BASE = 'https://shopee.phamkhanhminhman.com';
const ALARM = 'shopee-cart-sync';
const DEFAULT_HOURS = 4;

let running = false;

async function intervalMinutes() {
  const { intervalHours } = await chrome.storage.local.get('intervalHours');
  return (Number(intervalHours) || DEFAULT_HOURS) * 60;
}

async function scheduleAlarm() {
  const minutes = await intervalMinutes();
  await chrome.alarms.clear(ALARM);
  chrome.alarms.create(ALARM, { delayInMinutes: minutes, periodInMinutes: minutes });
}

function waitForLoad(tabId, timeoutMs = 25000) {
  return new Promise(resolve => {
    const timer = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }
    function onUpdated(id, info) {
      if (id === tabId && info.status === 'complete') done();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function saveStatus(status) {
  const at = Date.now();
  await chrome.storage.local.set({ lastStatus: { ...status, at }, ...(status.ok ? { lastOkAt: at } : {}) });
  await chrome.action.setBadgeText({ text: status.ok ? '' : '!' });
  if (!status.ok) await chrome.action.setBadgeBackgroundColor({ color: '#B5381A' });
  return status;
}

async function scanCart(source) {
  if (running) return { ok: false, error: 'Đang có lượt quét chạy dở.' };
  const { blocked } = await chrome.storage.local.get('blocked');
  if (blocked && source !== 'manual') {
    return { ok: false, error: 'Đã tạm dừng tự động vì Shopee yêu cầu xác minh. Hoàn tất xác minh rồi bấm Quét giỏ hàng ngay.' };
  }

  running = true;
  let tempTabId = null;
  try {
    const [existing] = await chrome.tabs.query({ url: 'https://shopee.vn/cart*' });
    let tabId;
    if (existing && existing.id !== undefined) {
      tabId = existing.id;
      const loaded = waitForLoad(tabId);
      await chrome.tabs.reload(tabId);
      await loaded;
    } else {
      const tab = await chrome.tabs.create({ url: 'https://shopee.vn/cart', active: false });
      tabId = tempTabId = tab.id;
      await waitForLoad(tabId);
    }

    await chrome.scripting.executeScript({ target: { tabId }, files: ['content-scrape.js'] });
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.__scrapeShopeeCart(),
    });
    const scrape = injection && injection.result;
    if (!scrape || !scrape.ok) {
      if (scrape && scrape.blocked) await chrome.storage.local.set({ blocked: true });
      return saveStatus({ ok: false, error: (scrape && scrape.error) || 'Không đọc được giỏ hàng Shopee.' });
    }

    const response = await fetch(API_BASE + '/api/sync/cart', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'chrome-' + source, items: scrape.items }),
    });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(body.error || 'HTTP ' + response.status);

    await chrome.storage.local.set({ blocked: false });
    return saveStatus({ ok: true, total: body.run.totalInCart, changed: body.run.changedCount, alerts: body.alertsSent });
  } catch (err) {
    return saveStatus({ ok: false, error: err instanceof Error ? err.message : String(err) });
  } finally {
    if (tempTabId !== null) chrome.tabs.remove(tempTabId).catch(() => {});
    running = false;
  }
}

chrome.runtime.onInstalled.addListener(scheduleAlarm);

// Máy ngủ hoặc Chrome tắt qua giờ hẹn: quét bù ngay khi Chrome mở lại.
chrome.runtime.onStartup.addListener(async () => {
  if (!(await chrome.alarms.get(ALARM))) await scheduleAlarm();
  const { lastOkAt } = await chrome.storage.local.get('lastOkAt');
  if (Date.now() - (lastOkAt || 0) >= (await intervalMinutes()) * 60000) scanCart('startup');
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM) scanCart('alarm');
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
