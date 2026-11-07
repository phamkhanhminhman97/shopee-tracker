const statusEl = document.getElementById('status');
const scanBtn = document.getElementById('scan');
const intervalEl = document.getElementById('interval');

function render(status) {
  if (!status) return;
  const d = new Date(status.at);
  const pad = n => String(n).padStart(2, '0');
  const when = pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  statusEl.className = status.ok ? 'ok' : 'err';
  statusEl.textContent = status.ok
    ? 'Đã đồng bộ ' + status.total + ' món lúc ' + when + ' (' + status.changed + ' đổi giá, ' + status.alerts + ' báo Telegram).'
    : 'Lỗi lúc ' + when + ': ' + status.error;
}

chrome.storage.local.get(['intervalHours', 'lastStatus'], data => {
  intervalEl.value = String(data.intervalHours ?? 4);
  render(data.lastStatus);
});

scanBtn.addEventListener('click', () => {
  scanBtn.disabled = true;
  scanBtn.textContent = 'Đang quét...';
  statusEl.className = '';
  statusEl.textContent = 'Đang tải giỏ hàng, chờ vài giây...';
  chrome.runtime.sendMessage({ type: 'SYNC_NOW' }, () => {
    scanBtn.disabled = false;
    scanBtn.textContent = 'Quét giỏ hàng ngay';
    chrome.storage.local.get('lastStatus', data => render(data.lastStatus));
  });
});

intervalEl.addEventListener('change', () => {
  chrome.storage.local.set({ intervalHours: Number(intervalEl.value) });
});
