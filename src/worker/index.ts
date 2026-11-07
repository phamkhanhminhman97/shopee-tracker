import { evaluateDeal } from '../lib/deal.ts';
import type { Env } from './env.d.ts';
import { InputError, isPrice, parseSnapshot, readJson, requireWriteHeader } from './input.ts';
import { checkSyncHealth } from './monitor.ts';
import { deliverDueAlerts, retryPendingAlerts } from './alert-delivery.ts';
import {
  getAppState,
  getItemHistory,
  claimUntil,
  claimCartSync,
  releaseClaim,
  recordSyncRun,
  updateItemSettings,
  upsertCartSnapshot,
} from './store.ts';
import { buildTestMessageHtml, sendTelegramHtml } from './telegram.ts';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' },
  });
}

function cartKey(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw new InputError('Mã phân loại không hợp lệ');
  }
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
      return json({ points: await getItemHistory(env.DB, cartKey(history[1])) });
    }

    const item = /^\/api\/items\/([^/]+)$/.exec(path);
    if (item && method === 'PATCH') {
      requireWriteHeader(request);
      const { targetPrice, alertMuted } = await readJson(request);
      if (targetPrice !== undefined && targetPrice !== null && !isPrice(targetPrice)) {
        return json({ ok: false, error: 'Giá canh không hợp lệ' }, 400);
      }
      if (alertMuted !== undefined && typeof alertMuted !== 'boolean') {
        return json({ ok: false, error: 'Giá trị tắt báo không hợp lệ' }, 400);
      }
      const key = cartKey(item[1]);
      const claim = await claimCartSync(env.DB);
      if (!claim) throw new InputError('Đang đồng bộ giỏ hàng. Hãy thử lưu lại sau vài giây.', 409);
      try {
        const found = await updateItemSettings(env.DB, key, { targetPrice, alertMuted });
        return found ? json({ ok: true }) : json({ ok: false, error: 'Không tìm thấy sản phẩm' }, 404);
      } finally {
        await releaseClaim(env.DB, 'sync_lock', claim);
      }
    }

    if (path === '/api/sync/cart' && method === 'POST') {
      requireWriteHeader(request);
      const body = await readJson(request);
      const items = parseSnapshot(body);
      const source = typeof body.source === 'string' && /^[a-z0-9-]{1,48}$/.test(body.source) ? body.source : 'chrome';
      const claim = await claimCartSync(env.DB);
      if (!claim) throw new InputError('Đang xử lý lượt đồng bộ khác.', 409);

      try {
        const sync = await upsertCartSnapshot(env.DB, items, new Date().toISOString(), telegramConfigured);
        if (!sync) throw new InputError('Một số món vắng mặt. Hãy quét lại để xác nhận danh sách mới.', 409);
        let alertsSent = 0;
        let telegramOk: boolean | null = null;
        let note = '';

        if (telegramConfigured) {
          const now = Date.parse(sync.syncedAt);
          const sent = await deliverDueAlerts(env, appUrl, now, fetchImpl);
          alertsSent = sent.sentCount;
          telegramOk = sent.ok;
          const queued = await env.DB.prepare('SELECT count(*) FROM alert_outbox').first<number>('count(*)');
          note = [
            alertsSent ? 'Đã báo ' + alertsSent + ' món' : '',
            queued ? queued + ' món chờ gửi' : '',
          ].filter(Boolean).join(' · ');
        } else if (sync.alerts.length) {
          note = sync.alerts.length + ' món đáng chốt nhưng chưa cấu hình Telegram';
        }

        const run = await recordSyncRun(env.DB, {
          syncedAt: sync.syncedAt,
          source,
          totalInCart: sync.total,
          changedCount: sync.changed,
          alertsSent,
          telegramOk,
          note,
        });
        return json({ ok: true, run, alertsSent });
      } finally {
        await releaseClaim(env.DB, 'sync_lock', claim);
      }
    }

    if (path === '/api/telegram/test' && method === 'POST') {
      requireWriteHeader(request);
      if (!telegramConfigured) throw new InputError('Chưa cấu hình Telegram', 503);
      const now = Date.now();
      if (!await claimUntil(env.DB, 'telegram_test', String(now + 60_000), now)) {
        throw new InputError('Chờ một phút rồi gửi lại tin thử.', 429);
      }
      const state = await getAppState(env.DB, telegramConfigured);
      const worthCount = state.items.filter(i => evaluateDeal(i).isWorth).length;
      const sent = await sendTelegramHtml(env, buildTestMessageHtml(worthCount, appUrl), fetchImpl);
      return sent.ok
        ? json({ ok: true, messageId: sent.messageId ?? null })
        : json({ ok: false, error: sent.error || 'Không gửi được tin nhắn Telegram' }, 502);
    }

    return json({ ok: false, error: 'Không tìm thấy đường dẫn API' }, 404);
  } catch (err) {
    if (err instanceof InputError) return json({ ok: false, error: err.message }, err.status);
    const route = path.startsWith('/api/items/')
      ? '/api/items/:key'
      : ['/api/health', '/api/state', '/api/sync/cart', '/api/telegram/test'].includes(path) ? path : 'unknown';
    console.error({ event: 'api_error', method, route, error: err instanceof Error ? err.name : 'unknown' });
    return json({ ok: false, error: 'Lỗi máy chủ nội bộ' }, 500);
  }
}

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron === '0 * * * *') await checkSyncHealth(env, controller.scheduledTime);
    else await retryPendingAlerts(env, Date.now());
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname.startsWith('/api/')) return handleApiRequest(request, env);
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not Found', { status: 404 });
  },
};
