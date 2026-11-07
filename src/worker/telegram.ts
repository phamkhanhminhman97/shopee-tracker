import { formatVnd, localizeShopeeNote, type TrackedItem } from '../lib/model.ts';
import type { Deal } from '../lib/deal.ts';
import type { Env } from './env.d.ts';

export interface AlertCandidate {
  item: TrackedItem;
  deals: Deal[];
}

export function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const observedTime = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit',
});

export function buildAlertMessageHtml(alerts: AlertCandidate[], appUrl: string, observedAt?: number): string {
  const blocks = alerts.map(({ item, deals }, index) => {
    const title = item.title.length > 88 ? item.title.slice(0, 85).trim() + '...' : item.title;
    const lines = [
      index + 1 + '. <b>' + escapeHtml(title) + '</b>' + (item.variation ? ' [' + escapeHtml(item.variation.slice(0, 40)) + ']' : ''),
      '   Giá ghi nhận: <b>' + formatVnd(item.effectivePrice) + '</b> (' + deals[0].channel + ')',
      ...deals.map(deal => '   ' + escapeHtml(deal.reason)),
    ];
    if (deals[0].channel === 'Shopee Live') lines.push('   Giỏ thường: ' + formatVnd(item.unitPrice));
    if (item.voucherHint) lines.push('   ' + escapeHtml(localizeShopeeNote(item.voucherHint).slice(0, 60)));
    lines.push('   <a href="' + escapeHtml(item.productUrl) + '">Mở trên Shopee</a>');
    return lines.join('\n');
  });
  return [
    '<b>' + alerts.length + ' món đang có giá tốt</b>',
    ...(observedAt === undefined ? [] : ['Ghi nhận từ ' + observedTime.format(observedAt)]),
    '',
    ...blocks,
    '',
    '<a href="' + escapeHtml(appUrl) + '">Mở sổ canh giá</a>',
  ].join('\n');
}

export function buildTestMessageHtml(worthCount: number, appUrl: string): string {
  return [
    '<b>Sổ Canh Giá Shopee đã kết nối Telegram.</b>',
    worthCount > 0 ? worthCount + ' món đang đáng chốt.' : 'Chưa có món nào đáng chốt.',
    '<a href="' + escapeHtml(appUrl) + '">Mở sổ canh giá</a>',
  ].join('\n');
}

export async function sendTelegramHtml(
  env: Env,
  html: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; messageId?: number; error?: string; retryAfter?: number }> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return { ok: false, error: 'Chưa cấu hình TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID' };

  try {
    const res = await fetchImpl('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const body = (await res.json()) as { ok?: boolean; description?: string; result?: { message_id?: number }; parameters?: { retry_after?: number } };
    if (!res.ok || !body.ok) {
      const delay = body.parameters?.retry_after;
      return { ok: false, error: body.description || 'HTTP ' + res.status, retryAfter: delay && delay > 0 && Number.isSafeInteger(delay) ? delay : undefined };
    }
    return { ok: true, messageId: body.result?.message_id };
  } catch {
    return { ok: false, error: 'Không kết nối được với Telegram' };
  }
}
