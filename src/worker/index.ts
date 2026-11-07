import type { CartSnapshotItem, UpdateItemPayload } from '../lib/model.ts';
import { evaluateDeal } from '../lib/deal.ts';
import type { Env } from './env.d.ts';
import {
  getAppState,
  getItemHistory,
  markAlertsDelivered,
  recordSyncRun,
  updateItemSettings,
  upsertCartSnapshot,
} from './store.ts';
import { buildAlertMessageHtml, buildTestMessageHtml, sendTelegramHtml } from './telegram.ts';

const MAX_SNAPSHOT_ITEMS = 200;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function handleApiRequest(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const telegramConfigured = Boolean(env.TELEGRAM_BOT_TOKEN?.trim() && env.TELEGRAM_CHAT_ID?.trim());
  const appUrl = env.APP_PUBLIC_URL?.trim() || url.origin;

  try {
    if (path === '/api/health' && method === 'GET') {
      const latestRun = await env.DB.prepare(
        'SELECT id, synced_at, total_in_cart, changed_count, alerts_sent FROM sync_runs ORDER BY id DESC LIMIT 1'
      ).first();
      return json({ ok: true, service: 'shopee-tracker', telegramConfigured, latestRun: latestRun ?? null });
    }

    if (path === '/api/state' && method === 'GET') {
      return json(await getAppState(env.DB, telegramConfigured));
    }

    const history = /^\/api\/items\/([^/]+)\/history$/.exec(path);
    if (history && method === 'GET') {
      return json({ points: await getItemHistory(env.DB, decodeURIComponent(history[1])) });
    }

    const item = /^\/api\/items\/([^/]+)$/.exec(path);
    if (item && method === 'PATCH') {
      const payload = (await request.json()) as UpdateItemPayload;
      const { targetPrice, alertMuted } = payload;
      if (targetPrice !== undefined && targetPrice !== null && !(Number.isFinite(targetPrice) && targetPrice > 0)) {
        return json({ ok: false, error: 'Giá canh không hợp lệ' }, 400);
      }
      if (alertMuted !== undefined && typeof alertMuted !== 'boolean') {
        return json({ ok: false, error: 'Giá trị tắt báo không hợp lệ' }, 400);
      }
      const found = await updateItemSettings(env.DB, decodeURIComponent(item[1]), { targetPrice, alertMuted });
      return found ? json({ ok: true }) : json({ ok: false, error: 'Không tìm thấy sản phẩm' }, 404);
    }

    if (path === '/api/sync/cart' && method === 'POST') {
      const body = (await request.json()) as { source?: string; items?: CartSnapshotItem[] };
      if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > MAX_SNAPSHOT_ITEMS) {
        return json({ ok: false, error: 'Danh sách giỏ hàng phải có từ 1 đến ' + MAX_SNAPSHOT_ITEMS + ' món' }, 400);
      }

      const sync = await upsertCartSnapshot(env.DB, body.items);
      let alertsSent = 0;
      let telegramOk: boolean | null = null;
      let note = '';

      if (sync.alerts.length > 0) {
        if (telegramConfigured) {
          const sent = await sendTelegramHtml(env, buildAlertMessageHtml(sync.alerts, appUrl), fetchImpl);
          telegramOk = sent.ok;
          if (sent.ok) {
            alertsSent = sync.alerts.length;
            await markAlertsDelivered(env.DB, sync.alerts);
            note = 'Đã báo ' + alertsSent + ' món về Telegram';
          } else {
            note = 'Gửi Telegram lỗi: ' + (sent.error || 'không rõ');
          }
        } else {
          note = sync.alerts.length + ' món đáng chốt nhưng chưa cấu hình Telegram';
        }
      }

      const run = await recordSyncRun(env.DB, {
        syncedAt: sync.syncedAt,
        source: (body.source || 'chrome').slice(0, 48),
        totalInCart: sync.total,
        changedCount: sync.changed,
        alertsSent,
        telegramOk,
        note,
      });
      return json({ ok: true, run, alertsSent });
    }

    if (path === '/api/telegram/test' && method === 'POST') {
      const state = await getAppState(env.DB, telegramConfigured);
      const worthCount = state.items.filter(i => evaluateDeal(i).isWorth).length;
      const sent = await sendTelegramHtml(env, buildTestMessageHtml(worthCount, appUrl), fetchImpl);
      return sent.ok
        ? json({ ok: true, messageId: sent.messageId ?? null })
        : json({ ok: false, error: sent.error || 'Không gửi được tin nhắn Telegram' }, 502);
    }

    return json({ ok: false, error: 'Không tìm thấy đường dẫn API' }, 404);
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : 'Lỗi máy chủ nội bộ' }, 500);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname.startsWith('/api/')) return handleApiRequest(request, env);
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not Found', { status: 404 });
  },
};
