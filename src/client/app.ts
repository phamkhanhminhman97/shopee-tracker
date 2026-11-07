import { evaluateDeal, type Deal } from '../lib/deal.ts';
import { ICONS } from '../lib/icons.ts';
import {
  formatVnd,
  localizeShopeeNote,
  parseTargetPrice,
  type AppStateResponse,
  type PricePoint,
  type TrackedItem,
} from '../lib/model.ts';

type View = 'cart' | 'worth' | 'connect';
type Sort = 'deal' | 'cart' | 'price' | 'manual';
interface Row {
  item: TrackedItem;
  deal: Deal;
}

const STALE_HOURS = 8;
const REFETCH_AFTER_MS = 60_000;
const ORDER_KEY = 'shopee-tracker:order';
const SORT_KEY = 'shopee-tracker:sort';
const SOURCE_LABELS: Record<string, string> = {
  'chrome-initial-sync': 'Lần đầu',
  'chrome-alarm': 'Tự động',
  'chrome-manual': 'Bấm tay',
  'chrome-startup': 'Mở Chrome',
  'chrome-retry': 'Thử lại',
};

let data: AppStateResponse | null = null;
let lastPayload = '';
let requestVersion = 0;
let loadError = '';
let loadedAt = 0;
let view: View = 'cart';
let query = '';
let sort: Sort = readSort();
let manualOrder = readOrder();
let editingOrder = false;
let dragKey = '';
let dialogKey: string | null = null;
let redrawChart: (() => void) | null = null;
let telegramSending = false;
let telegramFeedback = '';
let telegramFeedbackError = false;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const icon = (name: string): string => '<svg class="i" viewBox="0 0 256 256" aria-hidden="true">' + ICONS[name] + '</svg>';

// Shopee phục vụ bản 320 px khi thêm hậu tố _tn (đã kiểm 25/25 ảnh trong giỏ): trung bình 25 KB thay vì 458 KB.
const thumbUrl = (url: string): string => (/susercontent\.com\/file\/[\w-]+$/.test(url) ? url + '_tn' : url);

function readSort(): Sort {
  try {
    const saved = localStorage.getItem(SORT_KEY);
    if (saved === 'cart' || saved === 'price' || saved === 'manual') return saved;
  } catch {}
  return 'deal';
}

function readOrder(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]');
    if (Array.isArray(saved)) return [...new Set(saved.filter((key): key is string => typeof key === 'string'))];
  } catch {}
  return [];
}

function setSort(value: Sort): void {
  sort = value;
  try { localStorage.setItem(SORT_KEY, value); } catch {}
}

function saveOrder(keys: string[]): void {
  manualOrder = keys;
  try { localStorage.setItem(ORDER_KEY, JSON.stringify(keys)); } catch {}
}

function ago(iso: string): string {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return 'vừa xong';
  if (mins < 60) return mins + ' phút trước';
  const hours = Math.floor(mins / 60);
  return hours < 24 ? hours + ' giờ trước' : Math.floor(hours / 24) + ' ngày trước';
}

const pad = (n: number): string => String(n).padStart(2, '0');

function shortDate(iso: string): string {
  const d = new Date(iso);
  return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function rows(): Row[] {
  const q = editingOrder ? '' : query.trim().toLowerCase();
  const ranks = sort === 'manual' ? new Map(manualOrder.map((key, index) => [key, index])) : null;
  const list = (data?.items ?? [])
    .map(item => ({ item, deal: evaluateDeal(item) }))
    .filter(
      ({ item, deal }) =>
        (view !== 'worth' || deal.isWorth) &&
        (!q || (item.title + ' ' + item.variation + ' ' + item.shopName).toLowerCase().includes(q))
    );
  list.sort((a, b) => {
    if (ranks) return (ranks.get(a.item.cartKey) ?? ranks.size) - (ranks.get(b.item.cartKey) ?? ranks.size)
      || a.item.cartOrder - b.item.cartOrder;
    if (sort === 'price') return a.item.effectivePrice - b.item.effectivePrice;
    if (sort === 'deal' && a.deal.isWorth !== b.deal.isWorth) return a.deal.isWorth ? -1 : 1;
    if (sort === 'deal' && a.deal.savings !== b.deal.savings) return b.deal.savings - a.deal.savings;
    return a.item.cartOrder - b.item.cartOrder;
  });
  return list;
}

function renderOrderToolbar(): void {
  const enabled = view === 'cart' && (data?.items.length ?? 0) > 1;
  if (!enabled) editingOrder = false;
  $('order-toolbar').hidden = !enabled;
  $('order-help').hidden = !editingOrder;
  const edit = $('edit-order');
  edit.textContent = editingOrder ? 'Xong' : 'Đổi vị trí';
  edit.setAttribute('aria-pressed', String(editingOrder));
  $<HTMLSelectElement>('sort').value = sort;
}

function renderChrome(): void {
  const items = data?.items ?? [];
  $('count-cart').textContent = data ? String(items.length) : '';
  $('count-worth').textContent = data ? String(items.filter(i => evaluateDeal(i).isWorth).length) : '';
  for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-view]')) {
    tab.setAttribute('aria-pressed', String(tab.dataset.view === view));
  }

  let message: string;
  let stale = false;
  if (!data) {
    message = loadError ? 'Chưa tải được dữ liệu' : 'Đang tải...';
  } else if (!data.lastSyncedAt) {
    message = 'Chưa có lượt đồng bộ nào';
  } else {
    const hours = (Date.now() - new Date(data.lastSyncedAt).getTime()) / 3_600_000;
    stale = hours > STALE_HOURS;
    message = stale
      ? 'Đã ' + Math.floor(hours) + ' giờ chưa đồng bộ. Kiểm tra Chrome và tiện ích.'
      : 'Cập nhật ' + ago(data.lastSyncedAt) + (data.telegramConfigured ? ' · Telegram đang bật' : ' · Chưa bật Telegram');
  }
  const summary = $('sync-meta');
  if (summary.textContent !== message || summary.classList.contains('is-stale') !== stale) {
    summary.innerHTML = (stale ? icon('warning') : '') + '<span>' + esc(message) + '</span>';
    summary.classList.toggle('is-stale', stale);
  }
}

function emptyState(iconName: string, title: string, body: string, action = '', role = ''): string {
  return `<div class="empty"${role ? ' role="' + role + '"' : ''}>${icon(iconName)}<h2>${esc(title)}</h2><p>${esc(body)}</p>${action}</div>`;
}

function renderRow({ item, deal }: Row, index: number, list: Row[]): string {
  const notes: string[] = [];
  if (deal.channel === 'Shopee Live') notes.push('Giá Live · giỏ thường ' + formatVnd(item.unitPrice));
  if (item.minEffectivePrice < item.effectivePrice) notes.push('Thấp nhất đã ghi nhận ' + formatVnd(item.minEffectivePrice));

  const chips: string[] = [];
  if (deal.isWorth) chips.push('<span class="chip is-deal">' + icon('trend-down') + esc(deal.reason) + '</span>');
  if (item.targetPrice !== null && item.effectivePrice > item.targetPrice) {
    chips.push('<span class="chip">Giá canh ' + formatVnd(item.targetPrice) + '</span>');
  }
  for (const note of [item.voucherHint, item.flashSaleText, item.cartDropBadge]) {
    if (note) chips.push('<span class="chip">' + esc(localizeShopeeNote(note)) + '</span>');
  }
  if (item.alertMuted) chips.push('<span class="chip">' + icon('bell-slash') + 'Đã tắt báo Telegram</span>');

  const thumb = item.imageUrl
    ? `<img class="thumb" src="${esc(thumbUrl(item.imageUrl))}" alt="" width="56" height="56" loading="lazy" referrerpolicy="no-referrer" />`
    : '<span class="thumb" aria-hidden="true"></span>';

  const targetLabel = item.targetPrice ? 'Sửa giá canh' : 'Đặt giá canh';
  const name = esc(item.title + (item.variation ? ', ' + item.variation : ''));
  const actions = editingOrder
    ? `<div class="move-actions">
      <span class="move-grip" data-grip draggable="true" aria-hidden="true" title="Kéo để đổi vị trí">${icon('grip')}</span>
      <button type="button" class="icbtn" data-move="up" aria-label="Đưa lên: ${name}"${index === 0 ? ' disabled' : ''}>${icon('caret-up')}</button>
      <button type="button" class="icbtn" data-move="down" aria-label="Đưa xuống: ${name}"${index === list.length - 1 ? ' disabled' : ''}>${icon('caret-down')}</button>
    </div>`
    : `<div class="actions">
      <button type="button" class="btn" data-open="${esc(item.cartKey)}" aria-label="${targetLabel}: ${name}">${targetLabel}</button>
      <a class="icbtn" href="${esc(item.productUrl)}" target="_blank" rel="noreferrer" aria-label="Mở trên Shopee: ${esc(item.title)}" title="Mở trên Shopee">${icon('arrow-square-out')}</a>
    </div>`;
  return `<article class="row${deal.isWorth ? ' is-worth' : ''}" data-key="${esc(item.cartKey)}">
    ${thumb}
    <div class="body">
      <p class="shop">${esc(item.shopName || 'Gian hàng Shopee')}</p>
      <h2 class="name">${esc(item.title)}</h2>
      ${item.variation ? '<p class="variation">Phân loại: ' + esc(item.variation) + '</p>' : ''}
      ${chips.length ? '<div class="chips">' + chips.join('') + '</div>' : ''}
    </div>
    <div class="price-box">
      <div class="price">${formatVnd(item.effectivePrice)}</div>
      ${notes.map(n => '<p class="price-note">' + esc(n) + '</p>').join('')}
    </div>
    ${actions}
  </article>`;
}

const SKELETON =
  '<div class="rows" role="status" aria-label="Đang tải sổ canh giá">' +
  '<div class="sk-row"><span class="thumb"></span><div class="sk-lines"><span class="sk"></span><span class="sk"></span></div></div>'.repeat(6) +
  '</div>';

function renderList(): void {
  const list = $('list');
  if (!data) {
    list.innerHTML = loadError
      ? emptyState('warning', 'Chưa tải được dữ liệu', loadError, '<button type="button" class="btn primary" data-action="retry">Tải lại</button>', 'alert')
      : SKELETON;
    return;
  }
  if (data.items.length === 0) {
    list.innerHTML = emptyState(
      'plugs-connected',
      'Chưa có món nào trong sổ',
      'Gắn tiện ích Chrome và quét giỏ hàng một lần để nạp danh sách.',
      '<button type="button" class="btn primary" data-action="connect">Xem cách gắn tiện ích</button>'
    );
    return;
  }
  const visible = rows();
  if (visible.length === 0) {
    const searching = query.trim() !== '';
    list.innerHTML = searching
      ? emptyState(
          'magnifying-glass',
          'Không có món nào khớp',
          'Không có món nào khớp "' + query.trim() + '".',
          '<button type="button" class="btn" data-action="clear-search">Xoá tìm kiếm</button>'
        )
      : emptyState(
          'trend-down',
          'Chưa có món nào đáng chốt',
          'Sổ sẽ báo về Telegram khi có món chạm giá canh, lập đáy mới hoặc có giá Live giảm sâu.'
        );
    return;
  }
  list.innerHTML = '<div class="rows' + (editingOrder ? ' is-reordering' : '') + '">' + visible.map(renderRow).join('') + '</div>';
}

function renderConnect(): void {
  const runs = data?.recentRuns ?? [];
  const setup = runs.length
    ? ''
    : `<section class="panel">
        <h2>Gắn tiện ích Chrome</h2>
        <p>Tiện ích đọc giỏ hàng bằng chính phiên Chrome đang đăng nhập Shopee của bạn.</p>
        <ol class="steps">
          <li>Mở <code>chrome://extensions</code> và bật Developer mode.</li>
          <li>Chọn Load unpacked, rồi chọn thư mục <code>extension</code> của dự án.</li>
          <li>Bấm biểu tượng tiện ích và chọn Quét giỏ hàng ngay.</li>
        </ol>
      </section>`;
  const telegram = `<section class="panel">
      <h2>Telegram</h2>
      <p>${data?.telegramConfigured
        ? 'Đã kết nối. Bot báo giá tốt và nhắc khi tiện ích ngừng đồng bộ.'
        : 'Chưa cấu hình Telegram trên Worker.'}</p>
      <button id="telegram-test" type="button" class="btn">Gửi tin thử</button>
      <p id="telegram-feedback" class="feedback" role="status" aria-live="polite"></p>
    </section>`;
  const body = runs
    .map(r => `<tr>
        <td>${esc(shortDate(r.syncedAt))}</td>
        <td>${esc(SOURCE_LABELS[r.source] ?? r.source)}</td>
        <td>${r.totalInCart} món</td>
        <td>${r.changedCount} đổi giá</td>
        <td>${esc(r.note) || (r.alertsSent > 0 ? 'Đã báo ' + r.alertsSent + ' món' : 'Không có gì để báo')}</td>
      </tr>`)
    .join('');
  const table = runs.length
    ? `<section class="panel wide">
        <h2 id="runs-title">Các lượt quét gần đây</h2>
        <div id="runs-scroll" class="table-scroll" role="region" aria-labelledby="runs-title" tabindex="0"><table>
          <thead><tr><th>Lúc</th><th>Cách quét</th><th>Giỏ hàng</th><th>Thay đổi</th><th>Kết quả</th></tr></thead>
          <tbody>${body}</tbody>
        </table></div>
      </section>`
    : '';
  $('connect').innerHTML = `<div class="panels">${setup}${telegram}</div>${table}`;

  const test = $<HTMLButtonElement>('telegram-test');
  updateTelegramFeedback();
  test.addEventListener('click', async () => {
    telegramSending = true;
    telegramFeedbackError = false;
    telegramFeedback = 'Đang gửi...';
    updateTelegramFeedback();
    try {
      const res = await fetch('/api/telegram/test', { method: 'POST', headers: { 'x-shopee-tracker': '1' } });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) throw new Error(body.error || 'HTTP ' + res.status);
      telegramFeedback = 'Đã gửi tin thử vào nhóm Telegram.';
    } catch (err) {
      telegramFeedbackError = true;
      telegramFeedback = 'Gửi thất bại: ' + (err instanceof Error ? err.message : String(err));
    } finally {
      telegramSending = false;
      updateTelegramFeedback();
    }
  });
}

function updateTelegramFeedback(): void {
  const test = $<HTMLButtonElement>('telegram-test');
  test.disabled = telegramSending || !data?.telegramConfigured;
  const feedback = $('telegram-feedback');
  feedback.classList.toggle('is-err', telegramFeedbackError);
  feedback.textContent = telegramFeedback;
}

function render(): void {
  renderChrome();
  renderOrderToolbar();
  const connect = view === 'connect';
  $('ledger').hidden = connect;
  $('tools').hidden = connect || editingOrder;
  $('connect').hidden = !connect;
  if (connect) renderConnect();
  else renderList();
}

async function load(): Promise<void> {
  const version = ++requestVersion;
  try {
    const res = await fetch('/api/state', { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error('Máy chủ trả mã ' + res.status);
    const payload = await res.text();
    if (version !== requestVersion) return;
    loadedAt = Date.now();
    if (payload === lastPayload) {
      renderChrome();
      return;
    }
    data = JSON.parse(payload) as AppStateResponse;
    lastPayload = payload;
    loadError = '';
  } catch (err) {
    if (version !== requestVersion) return;
    if (data) {
      renderChrome();
      return;
    }
    if (!data) loadError = err instanceof TypeError ? 'Không kết nối được tới máy chủ.' : err instanceof Error ? err.message : String(err);
  }
  const focused = document.activeElement;
  const rowKey = focused?.closest<HTMLElement>('.row')?.dataset.key;
  const rowSelector = rowKey ? '[data-key="' + CSS.escape(rowKey) + '"]' : '';
  const control = focused instanceof HTMLElement && focused.dataset.move
    ? '[data-move="' + focused.dataset.move + '"]:enabled'
    : focused?.tagName === 'A' ? 'a' : '[data-open]';
  const scroll = $('runs-scroll')?.scrollLeft;
  render();
  if (scroll && $('runs-scroll')) $('runs-scroll').scrollLeft = scroll;
  if (focused && !focused.isConnected) {
    const target = rowSelector ? document.querySelector<HTMLElement>(rowSelector + ' ' + control) : $(focused.id);
    if (target instanceof HTMLElement) target.focus({ preventScroll: true });
    else document.querySelector<HTMLElement>('[data-view="' + view + '"]')?.focus({ preventScroll: true });
  }
}

/* Biểu đồ bậc thang: nét đậm là giá mua tốt nhất, nét đứt là giá giỏ thường */
function renderChart(points: PricePoint[], item: TrackedItem, W: number): string {
  const H = 150;
  const pad = { l: 10, r: 10, t: 16, b: 24 };
  const series: PricePoint[] = points.length
    ? points
    : [{ recordedAt: item.firstSeenAt, unitPrice: item.unitPrice, streamingPrice: item.streamingPrice, effectivePrice: item.effectivePrice }];

  const values = series.flatMap(p => [p.effectivePrice, p.unitPrice]);
  const bestPrices = series.map(p => p.effectivePrice);
  const minBest = formatVnd(Math.min(...bestPrices));
  const maxBest = formatVnd(Math.max(...bestPrices));
  const range = minBest === maxBest ? 'Giá ghi nhận: ' + minBest : 'Thấp nhất ' + minBest + ' · Cao nhất ' + maxBest;
  $('chart-range').textContent = range;
  if (item.targetPrice) values.push(item.targetPrice);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  const margin = lo === hi ? Math.round(lo * 0.1) + 1000 : Math.round((hi - lo) * 0.12);
  lo = Math.max(0, lo - margin);
  hi += margin;

  const times = series.map(p => Date.parse(p.recordedAt));
  const duration = times[times.length - 1] - times[0];
  const x = (i: number): number => duration > 0
    ? pad.l + (times[i] - times[0]) / duration * (W - pad.l - pad.r)
    : W / 2;
  const y = (v: number): number => pad.t + (H - pad.t - pad.b) * (1 - (v - lo) / (hi - lo));
  const steps = (pick: (p: PricePoint) => number): string =>
    series.map((p, i) => (i === 0 ? 'M ' + x(0).toFixed(1) + ' ' + y(pick(p)).toFixed(1) : ' H ' + x(i).toFixed(1) + ' V ' + y(pick(p)).toFixed(1))).join('');

  const target = item.targetPrice
    ? `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(item.targetPrice).toFixed(1)}" y2="${y(item.targetPrice).toFixed(1)}" stroke="var(--ink-2)" stroke-width="1" />
       <text x="${W - pad.r}" y="${Math.max(30, y(item.targetPrice) - 5).toFixed(1)}" text-anchor="end" font-size="12" font-weight="500" fill="var(--ink-2)">Giá canh ${formatVnd(item.targetPrice)}</text>`
    : '';
  const lines =
    series.length > 1
      ? `<path d="${steps(p => p.unitPrice)}" fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="3 3" />
         <path d="${steps(p => p.effectivePrice)}" fill="none" stroke="var(--accent)" stroke-width="2.5" />`
      : '';
  const dots = series.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.effectivePrice).toFixed(1)}" r="4" fill="var(--accent)"><title>${esc(shortDate(p.recordedAt))} · ${formatVnd(p.effectivePrice)}</title></circle>`).join('');
  const axis = `<text x="${duration > 0 ? pad.l : W / 2}" text-anchor="${duration > 0 ? 'start' : 'middle'}" y="${H - 6}" font-size="12" fill="var(--muted)">${esc(shortDate(series[0].recordedAt))}</text>` +
    (duration > 0
      ? `<text x="${W - pad.r}" y="${H - 6}" text-anchor="end" font-size="12" fill="var(--muted)">${esc(shortDate(series[series.length - 1].recordedAt))}</text>`
      : '');

  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Biểu đồ lịch sử giá. ${range}">
    <line x1="${pad.l}" x2="${W - pad.r}" y1="${H - pad.b}" y2="${H - pad.b}" stroke="var(--line)" />
    ${lines}${target}${dots}${axis}
  </svg>`;
}

async function openDialog(key: string): Promise<void> {
  const item = data?.items.find(i => i.cartKey === key);
  if (!item) return;
  dialogKey = key;

  $('dialog-title').textContent = item.title;
  $('dialog-sub').textContent = [item.shopName, item.variation && 'Phân loại ' + item.variation, 'Hiện tại ' + formatVnd(item.effectivePrice)]
    .filter(Boolean)
    .join(' · ');
  $('chart-legend').textContent =
    'Theo dõi từ ' + shortDate(item.firstSeenAt) + '. Nét đậm là giá mua tốt nhất, nét đứt là giá giỏ thường.';
  $<HTMLInputElement>('target').value = item.targetPrice ? String(item.targetPrice) : '';
  $<HTMLInputElement>('mute').checked = item.alertMuted;
  $('dialog-feedback').textContent = '';
  $('dialog-feedback').className = 'feedback';

  $('presets').innerHTML = [5, 10, 15]
    .map(pct => {
      const value = Math.floor(item.effectivePrice * (100 - pct) / 100);
      return value > 0
        ? `<button type="button" class="btn" data-preset="${value}">Giảm ${pct}% (${formatVnd(value)})</button>`
        : '';
    })
    .join('');

  const chart = $('chart');
  let points: PricePoint[] = [];
  const draw = () => { chart.innerHTML = renderChart(points, item, Math.max(1, chart.clientWidth)); };
  redrawChart = draw;
  $<HTMLDialogElement>('dialog').showModal();
  draw();

  try {
    const res = await fetch('/api/items/' + encodeURIComponent(key) + '/history');
    if (res.ok) {
      points = ((await res.json()) as { points: PricePoint[] }).points;
      if (redrawChart === draw) draw();
    }
  } catch {
    /* biểu đồ một điểm vẫn dùng được */
  }
}

async function saveSettings(): Promise<void> {
  if (!dialogKey) return;
  const feedback = $('dialog-feedback');
  const raw = $<HTMLInputElement>('target').value.trim();
  const target = raw === '' ? null : parseTargetPrice(raw);
  if (raw !== '' && target === null) {
    feedback.className = 'feedback is-err';
    feedback.textContent = 'Nhập số tiền VNĐ hợp lệ, ví dụ 350000 hoặc 350k.';
    return;
  }

  const save = $<HTMLButtonElement>('save');
  save.disabled = true;
  try {
    const res = await fetch('/api/items/' + encodeURIComponent(dialogKey), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-shopee-tracker': '1' },
      body: JSON.stringify({ targetPrice: target, alertMuted: $<HTMLInputElement>('mute').checked }),
    });
    const body = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || !body.ok) throw new Error(body.error || 'HTTP ' + res.status);
    await load();
    feedback.className = 'feedback is-ok';
    const current = data?.items.find(item => item.cartKey === dialogKey)?.effectivePrice;
    feedback.textContent = target ? 'Đã lưu giá canh ' + formatVnd(target) + '.'
      + (current !== undefined && current <= target ? ' Giá hiện tại đã chạm mức này.' : '') : 'Đã lưu.';
  } catch (err) {
    feedback.className = 'feedback is-err';
    feedback.textContent = 'Không lưu được: ' + (err instanceof Error ? err.message : String(err));
  } finally {
    save.disabled = false;
  }
}

function moveProduct(key: string, target: string, after: boolean, focus?: string): void {
  if (!editingOrder || key === target) return;
  const visible = rows().map(row => row.item.cartKey);
  if (!visible.includes(key) || !visible.includes(target)) return;
  const active = new Set(visible);
  const order = visible.filter(id => id !== key);
  const position = order.indexOf(target) + Number(after);
  order.splice(position, 0, key);
  saveOrder([...order, ...manualOrder.filter(id => !active.has(id))]);
  renderList();
  const moved = data?.items.find(item => item.cartKey === key);
  $('order-status').textContent = (moved?.title ?? 'Sản phẩm') + ' ở vị trí ' + (position + 1) + ' / ' + order.length + '.';
  if (focus) {
    const row = document.querySelector<HTMLElement>('[data-key="' + CSS.escape(key) + '"]');
    (row?.querySelector<HTMLButtonElement>('[data-move="' + focus + '"]:enabled')
      ?? row?.querySelector<HTMLButtonElement>('[data-move]:enabled'))?.focus();
  }
}

function bindReordering(): void {
  $('edit-order').addEventListener('click', () => {
    editingOrder = !editingOrder;
    if (editingOrder) {
      if (!manualOrder.length) saveOrder(rows().map(row => row.item.cartKey));
      setSort('manual');
    }
    render();
  });
  const list = $('list');
  list.addEventListener('click', e => {
    const button = (e.target as Element).closest<HTMLButtonElement>('[data-move]');
    const key = button?.closest<HTMLElement>('.row')?.dataset.key;
    if (!key || !button?.dataset.move) return;
    const keys = rows().map(row => row.item.cartKey);
    const down = button.dataset.move === 'down';
    const other = keys[keys.indexOf(key) + (down ? 1 : -1)];
    if (other) moveProduct(key, other, down, button.dataset.move);
  });
  const clearDrop = () => list.querySelector('.drop-before, .drop-after')?.classList.remove('drop-before', 'drop-after');
  const dropRow = (event: DragEvent) => (event.target as Element).closest<HTMLElement>('.row');
  const afterRow = (event: DragEvent, row: HTMLElement) => {
    const rect = row.getBoundingClientRect();
    return event.clientY > rect.top + rect.height / 2;
  };
  list.addEventListener('dragstart', e => {
    const grip = (e.target as Element).closest<HTMLElement>('[data-grip]');
    if (!editingOrder || !grip || !e.dataTransfer) return;
    dragKey = grip.closest<HTMLElement>('.row')?.dataset.key ?? '';
    e.dataTransfer.setData('text/plain', dragKey);
    e.dataTransfer.effectAllowed = 'move';
  });
  list.addEventListener('dragover', e => {
    const row = dropRow(e);
    if (!dragKey || !row || row.dataset.key === dragKey) {
      clearDrop();
      return;
    }
    e.preventDefault();
    clearDrop();
    row.classList.add(afterRow(e, row) ? 'drop-after' : 'drop-before');
  });
  list.addEventListener('dragleave', e => {
    if (!list.contains(e.relatedTarget as Node | null)) clearDrop();
  });
  list.addEventListener('drop', e => {
    const row = dropRow(e);
    if (!dragKey || !row?.dataset.key) return;
    e.preventDefault();
    const key = dragKey;
    dragKey = '';
    clearDrop();
    moveProduct(key, row.dataset.key, afterRow(e, row));
  });
  list.addEventListener('dragend', () => { dragKey = ''; clearDrop(); });
}

function bind(): void {
  bindReordering();
  for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-view]')) {
    tab.addEventListener('click', () => {
      if (view !== tab.dataset.view) editingOrder = false;
      view = tab.dataset.view as View;
      render();
    });
  }

  $<HTMLInputElement>('search').addEventListener('input', e => {
    query = (e.target as HTMLInputElement).value;
    render();
  });
  $<HTMLSelectElement>('sort').addEventListener('change', e => {
    setSort((e.target as HTMLSelectElement).value as Sort);
    render();
  });

  $('list').addEventListener('click', e => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-open], [data-action]');
    if (!target) return;
    if (target.dataset.open) void openDialog(target.dataset.open);
    else if (target.dataset.action === 'retry') void load();
    else if (target.dataset.action === 'connect') {
      view = 'connect';
      render();
    } else if (target.dataset.action === 'clear-search') {
      query = '';
      $<HTMLInputElement>('search').value = '';
      render();
    }
  });
  $('list').addEventListener('error', e => {
    if (!(e.target instanceof HTMLImageElement)) return;
    const placeholder = document.createElement('span');
    placeholder.className = 'thumb';
    placeholder.setAttribute('aria-hidden', 'true');
    e.target.replaceWith(placeholder);
  }, true);

  const dialog = $<HTMLDialogElement>('dialog');
  new ResizeObserver(() => redrawChart?.()).observe($('chart'));
  $('dialog-close').addEventListener('click', () => dialog.close());
  let startedOnBackdrop = false;
  dialog.addEventListener('pointerdown', e => { startedOnBackdrop = e.target === dialog; });
  dialog.addEventListener('click', e => {
    if (startedOnBackdrop && e.target === dialog) dialog.close();
    startedOnBackdrop = false;
  });
  dialog.addEventListener('close', () => {
    // Danh sách được vẽ lại sau khi lưu, nên tìm lại nút theo mã món thay vì giữ nút cũ.
    const key = dialogKey;
    dialogKey = null;
    redrawChart = null;
    if (key) document.querySelector<HTMLElement>('[data-open="' + CSS.escape(key) + '"]')?.focus();
  });
  $('presets').addEventListener('click', e => {
    const preset = (e.target as HTMLElement).closest<HTMLElement>('[data-preset]');
    if (preset) $<HTMLInputElement>('target').value = preset.dataset.preset ?? '';
  });
  $('target-form').addEventListener('submit', e => {
    e.preventDefault();
    void saveSettings();
  });

  // Sổ được cập nhật mỗi vài giờ từ Chrome: quay lại tab thì tải bản mới nếu đã cũ.
  const refresh = () => {
    if (document.hidden || dragKey || Date.now() - loadedAt < REFETCH_AFTER_MS) return;
    void load();
  };
  document.addEventListener('visibilitychange', refresh);
  window.setInterval(refresh, 5 * 60_000);

  document.addEventListener('keydown', e => {
    const typing = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLSelectElement;
    if (e.key === '/' && !editingOrder && !typing && !e.metaKey && !e.ctrlKey && !e.altKey && view !== 'connect') {
      e.preventDefault();
      $('search').focus();
    }
  });
}

bind();
render();
void load();
