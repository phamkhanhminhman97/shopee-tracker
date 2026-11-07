import { formatVnd, localizeShopeeNote, type TrackedItem } from '../lib/model.ts';
import type { Deal } from '../lib/deal.ts';
import type { Env } from './env.d.ts';

export interface AlertCandidate {
  item: TrackedItem;
  deal: Deal;
}

export function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const MAX_LISTED = 12;

export function buildAlertMessageHtml(alerts: AlertCandidate[], appUrl: string): string {
  const blocks = alerts.slice(0, MAX_LISTED).map(({ item, deal }, index) => {
    const title = item.title.length > 88 ? item.title.slice(0, 85).trim() + '...' : item.title;
    const lines = [
      index + 1 + '. <b>' + escapeHtml(title) + '</b>' + (item.variation ? ' [' + escapeHtml(item.variation) + ']' : ''),
      '   Giá tốt nhất: <b>' + formatVnd(item.effectivePrice) + '</b> (' + deal.channel + ')',
      '   ' + escapeHtml(deal.reason),
    ];
    if (deal.channel === 'Shopee Live') lines.push('   Giỏ thường: ' + formatVnd(item.unitPrice));
    if (item.voucherHint) lines.push('   ' + escapeHtml(localizeShopeeNote(item.voucherHint)));
    lines.push('   <a href="' + escapeHtml(item.productUrl) + '">Mở trên Shopee</a>');
    return lines.join('\n');
  });
  if (alerts.length > MAX_LISTED) blocks.push('Và ' + (alerts.length - MAX_LISTED) + ' món khác trong sổ canh giá.');

  return [
    '<b>' + alerts.length + ' món đang có giá tốt</b>',
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
): Promise<{ ok: boolean; messageId?: number; error?: string }> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return { ok: false, error: 'Chưa cấu hình TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID' };

  try {
    const res = await fetchImpl('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const body = (await res.json()) as { ok?: boolean; description?: string; result?: { message_id?: number } };
    if (!res.ok || !body.ok) return { ok: false, error: body.description || 'HTTP ' + res.status };
    return { ok: true, messageId: body.result?.message_id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
