import type { Env } from './env.d.ts';
import { claimUntil, getTrackerState, releaseClaim, setTrackerState } from './store.ts';
import { escapeHtml, sendTelegramHtml } from './telegram.ts';

const STALE_MS = 9 * 60 * 60 * 1000;

export async function checkSyncHealth(env: Env, now: number, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN?.trim() || !env.TELEGRAM_CHAT_ID?.trim()) return;
  const startedAt = Date.now();
  const claim = (startedAt + 60_000) + ':' + crypto.randomUUID();
  if (!await claimUntil(env.DB, 'monitor_lock', claim, startedAt)) return;
  try {
    await notifySyncHealth(env, now, fetchImpl);
  } finally {
    await releaseClaim(env.DB, 'monitor_lock', claim);
  }
}

async function notifySyncHealth(env: Env, now: number, fetchImpl: typeof fetch): Promise<void> {
  const lastSync = await env.DB.prepare('SELECT MAX(synced_at) FROM sync_runs').first<string>('MAX(synced_at)');
  if (!lastSync) return;
  const elapsed = now - Date.parse(lastSync);
  const stale = elapsed >= STALE_MS;
  const warned = await getTrackerState(env.DB, 'sync_warning') === '1';
  if (stale === warned) return;

  const title = stale ? 'Sổ Canh Giá Shopee chưa nhận được dữ liệu' : 'Sổ Canh Giá Shopee đã đồng bộ lại';
  const detail = stale
    ? 'Đã ' + Math.floor(elapsed / 3_600_000) + ' giờ chưa quét thành công. Mở Chrome và xem trạng thái tiện ích Shopee.'
    : 'Tiện ích đã gửi dữ liệu giỏ hàng trở lại.';
  const link = env.APP_PUBLIC_URL ? '\n<a href="' + escapeHtml(env.APP_PUBLIC_URL) + '">Mở sổ canh giá</a>' : '';
  const sent = await sendTelegramHtml(env, '<b>' + title + '</b>\n' + detail + link, fetchImpl);
  if (!sent.ok) throw new Error('Không gửi được cảnh báo trạng thái đồng bộ');
  await setTrackerState(env.DB, 'sync_warning', stale ? '1' : '0');
}
