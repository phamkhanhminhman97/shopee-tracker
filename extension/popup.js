const statusEl = document.getElementById('status');
const scanBtn = document.getElementById('scan');
const intervalEl = document.getElementById('interval');

function render(status) {
  if (!status) return;
  const d = new Date(status.at ?? Date.now());
  const pad = n => String(n).padStart(2, '0');
  const when = pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  statusEl.className = status.ok ? 'ok' : 'err';
  statusEl.textContent = status.ok
    ? 'Đã đồng bộ ' + status.total + ' món lúc ' + when + ' (' + status.changed + ' đổi giá, ' + status.alerts + ' báo Telegram).'
    : 'Lỗi lúc ' + when + ': ' + status.error;
}

chrome.storage.local.get(['intervalHours', 'lastStatus'], data => {
  intervalEl.value = String([3, 4, 6].includes(data.intervalHours) ? data.intervalHours : 4);
  if (!scanBtn.disabled) render(data.lastStatus);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.lastStatus) render(changes.lastStatus.newValue);
});

scanBtn.addEventListener('click', async () => {
  scanBtn.disabled = true;
  scanBtn.textContent = 'Đang quét...';
  statusEl.className = '';
  statusEl.textContent = 'Đang tải giỏ hàng, chờ vài giây...';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'SYNC_NOW' });
    render(result ?? { ok: false, error: 'Không nhận được kết quả từ tiện ích.' });
  } catch {
    render({ ok: false, error: 'Không liên lạc được với tiện ích. Hãy mở lại và thử lại.' });
  } finally {
    scanBtn.disabled = false;
    scanBtn.textContent = 'Quét giỏ hàng ngay';
  }
});

intervalEl.addEventListener('change', () => {
  chrome.storage.local.set({ intervalHours: Number(intervalEl.value) });
});
