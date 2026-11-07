import { eligibleDeals } from '../lib/deal.ts';
import type { Env } from './env.d.ts';
import { claimCartSync, dueAlerts, markAlertsDelivered, releaseClaim } from './store.ts';
import { buildAlertMessageHtml, sendTelegramHtml, type AlertCandidate } from './telegram.ts';

const MAX_AGE_MS = 30 * 60_000;
const RETRY_MS = 5 * 60_000;

// Called with the cart lock held, so a scan cannot change prices while a notification is sent.
export async function deliverDueAlerts(env: Env, appUrl: string, now: number, fetchImpl: typeof fetch) {
  const db = env.DB;
  await db.prepare('DELETE FROM alert_outbox WHERE observed_at <= ?').bind(now - MAX_AGE_MS).run();
  const ready: Array<AlertCandidate & { observedAt: number }> = [];
  const obsolete = [];
  for (const row of await dueAlerts(db, now)) {
    const deals = row.stillCurrent ? eligibleDeals(row.item, now) : [];
    if (deals.length) ready.push({ item: row.item, observedAt: row.observedAt, deals });
    else obsolete.push(db.prepare('DELETE FROM alert_outbox WHERE cart_key = ?').bind(row.item.cartKey));
  }
  if (obsolete.length) await db.batch(obsolete);
  let sentCount = 0;
  let ok: boolean | null = null;
  for (let batch = 0; batch < 2 && ready.length; batch++) {
    let size = Math.min(ready.length, 10);
    const render = () => {
      const group = ready.slice(0, size);
      return buildAlertMessageHtml(group, appUrl, Math.min(...group.map(row => row.observedAt)));
    };
    let message = render();
    while (message.length > 4000 && size > 1) {
      size--;
      message = render();
    }
    const group = ready.splice(0, size);
    const result = await sendTelegramHtml(env, message, fetchImpl);
    ok = result.ok;
    if (!result.ok) {
      const next = now + Math.max(RETRY_MS, (result.retryAfter ?? 0) * 1000);
      await db.prepare('UPDATE alert_outbox SET next_attempt_at = ? WHERE next_attempt_at < ?').bind(next, next).run();
      break;
    }
    await markAlertsDelivered(db, group, new Date(now).toISOString(), true);
    sentCount += group.length;
  }
  return { sentCount, ok };
}

export async function retryPendingAlerts(env: Env, now: number, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN?.trim() || !env.TELEGRAM_CHAT_ID?.trim()) return;
  if (!await env.DB.prepare('SELECT 1 FROM alert_outbox WHERE next_attempt_at <= ? OR observed_at <= ? LIMIT 1')
    .bind(now, now - MAX_AGE_MS).first()) return;
  const claim = await claimCartSync(env.DB);
  if (!claim) return;
  try {
    await deliverDueAlerts(env, env.APP_PUBLIC_URL || 'https://shopee.phamkhanhminhman.com', now, fetchImpl);
  } finally {
    await releaseClaim(env.DB, 'sync_lock', claim);
  }
}
