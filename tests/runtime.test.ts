import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { handleApiRequest } from '../src/worker/index.ts';
import type { Env } from '../src/worker/env.d.ts';
import { checkSyncHealth } from '../src/worker/monitor.ts';
import { retryPendingAlerts } from '../src/worker/alert-delivery.ts';
import { markAlertsDelivered, recordSyncRun, upsertCartSnapshot } from '../src/worker/store.ts';
import type { AppStateResponse, CartSnapshotItem } from '../src/lib/model.ts';

async function openDb() {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      compatibilityDate: '2026-11-07',
      script: 'export default { fetch() { return new Response("ok"); } }',
      d1Databases: ['DB'],
    })
  );
  return { mf, db: await mf.getD1Database('DB') as D1Database };
}

async function migrate(db: D1Database, file: string) {
  const sql = readFileSync(resolve(process.cwd(), 'migrations', file), 'utf8');
  for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
}

const snapshotItem = (overrides: Partial<CartSnapshotItem> = {}): CartSnapshotItem => ({
  shopId: '254666730',
  itemId: '28016604566',
  shopName: 'Elmich Việt Nam Chính Hãng',
  title: 'Cốc giữ nhiệt inox 304 Elmich 510ml',
  variation: 'Xanh min',
  productUrl: 'https://shopee.vn/item-i.254666730.28016604566',
  imageUrl: 'https://down-vn.img.susercontent.com/file/abc',
  cartOrder: 0,
  unitPrice: 199_000,
  streamingPrice: null,
  voucherHint: '',
  flashSaleText: '',
  cartDropBadge: '',
  ...overrides,
});

async function migrateAll(db: D1Database) {
  for (const file of ['0001_init.sql', '0002_trim.sql', '0003_tracker_state.sql', '0004_price_baselines.sql', '0005_alert_outbox.sql']) {
    await migrate(db, file);
  }
}

const writeHeaders = { 'content-type': 'application/json', 'x-shopee-tracker': '1' };

test('lỗi D1 có log theo đường dẫn, API trả lỗi chung', async t => {
  const { mf, db } = await openDb();
  try {
    const log = t.mock.method(console, 'error', () => {});
    const response = await handleApiRequest(new Request('https://example.com/api/state'), { DB: db });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { ok: false, error: 'Lỗi máy chủ nội bộ' });
    assert.equal(log.mock.callCount(), 1);
    assert.deepEqual(log.mock.calls[0].arguments, [
      { event: 'api_error', method: 'GET', route: '/api/state', error: 'Error' },
    ]);
  } finally {
    await mf.dispose();
  }
});

test('đồng bộ giỏ hàng: báo Telegram một lần khi giá giảm sâu, không báo lặp, món rời giỏ biến mất', { timeout: 15_000 }, async () => {
  const { mf, db } = await openDb();
  try {
    await migrateAll(db);

    const messages: string[] = [];
    let onSend: (() => Promise<void>) | undefined;
    const fakeFetch: typeof fetch = async (_input, init) => {
      messages.push((JSON.parse(String(init?.body)) as { text: string }).text);
      const hold = onSend;
      onSend = undefined;
      await hold?.();
      return Response.json({ ok: true, result: { message_id: 100 + messages.length } });
    };
    const env: Env = { DB: db, TELEGRAM_BOT_TOKEN: 'token', TELEGRAM_CHAT_ID: '-1', APP_PUBLIC_URL: 'https://shopee.example' };
    const call = (path: string, init?: RequestInit) =>
      handleApiRequest(new Request('https://shopee.example' + path, init), env, fakeFetch);
    const sync = async (items: unknown[]) =>
      (await (await call('/api/sync/cart', {
        method: 'POST',
        headers: writeHeaders,
        body: JSON.stringify({ source: 'test', items }),
      })).json()) as { ok: boolean; alertsSent: number; run: { totalInCart: number; changedCount: number } };

    const first = await sync([snapshotItem()]);
    assert.equal(first.alertsSent, 0);
    assert.equal(first.run.changedCount, 1);

    let reached = () => {};
    let release = () => {};
    const sending = new Promise<void>(resolve => { reached = resolve; });
    const finishSend = new Promise<void>(resolve => { release = resolve; });
    onSend = () => { reached(); return finishSend; };
    const drop = sync([snapshotItem({ unitPrice: 159_000 })]);
    await sending;
    try {
      const overlap = await call('/api/sync/cart', {
        method: 'POST', headers: writeHeaders, body: JSON.stringify({ items: [snapshotItem({ unitPrice: 159_000 })] }),
      });
      assert.equal(overlap.status, 409);
      const change = await call('/api/items/' + encodeURIComponent('254666730:28016604566:xanh min'), {
        method: 'PATCH', headers: writeHeaders, body: JSON.stringify({ alertMuted: true }),
      });
      assert.equal(change.status, 409);
    } finally {
      release();
    }
    assert.equal((await drop).alertsSent, 1);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /Đáy giá giỏ/);
    assert.equal(messages[0].includes('—'), false);

    assert.equal((await sync([snapshotItem({ unitPrice: 159_000 })])).alertsSent, 0);
    assert.equal(messages.length, 1);

    const other = snapshotItem({ shopId: '1', itemId: '2', variation: '', title: 'Món khác', unitPrice: 100_000 });
    assert.equal((await sync([other])).ok, false);
    await sync([other]);
    const state = (await (await call('/api/state')).json()) as { items: Array<{ title: string }>; lastSyncedAt: string };
    assert.deepEqual(state.items.map(i => i.title), ['Món khác']);
    assert.ok(state.lastSyncedAt);

    const key = encodeURIComponent('1:2:default');
    const patched = await call('/api/items/' + key, {
      method: 'PATCH',
      headers: writeHeaders,
      body: JSON.stringify({ targetPrice: 120_000, alertMuted: true }),
    });
    assert.equal(patched.status, 200);
    assert.equal((await call('/api/items/' + key, { method: 'PATCH', headers: writeHeaders, body: JSON.stringify({ targetPrice: -5 }) })).status, 400);
    assert.equal((await call('/api/items/khong-co', { method: 'PATCH', headers: writeHeaders, body: '{}' })).status, 404);
    assert.equal((await call('/api/sync/cart', { method: 'POST', headers: writeHeaders, body: JSON.stringify({ items: [] }) })).status, 400);

    const test = await call('/api/telegram/test', { method: 'POST', headers: writeHeaders });
    assert.equal(test.status, 200);
    assert.equal(messages.length, 2);
    assert.equal((await call('/api/telegram/test', { method: 'POST', headers: writeHeaders })).status, 429);
  } finally {
    await mf.dispose();
  }
});

test('migration 0002 giữ lịch sử giá, đưa món inactive ra khỏi giỏ và bỏ các cột không dùng', async () => {
  const { mf, db } = await openDb();
  try {
    await migrate(db, '0001_init.sql');
    const insertItem = (key: string, inactive: number) =>
      db
        .prepare(
          "INSERT INTO cart_items (cart_key, shop_id, item_id, title, product_url, unit_price, effective_price, first_unit_price, first_effective_price, min_effective_price, max_effective_price, is_inactive, first_seen_at, last_checked_at, last_changed_at) VALUES (?, '1', '2', 'Món', 'https://shopee.vn/x', 100000, 100000, 100000, 100000, 100000, 100000, ?, 't', 't', 't')"
        )
        .bind(key, inactive)
        .run();
    await insertItem('1:2:a', 0);
    await insertItem('1:2:b', 1);
    await db
      .prepare("INSERT INTO price_history (cart_key, recorded_at, unit_price, effective_price) VALUES ('1:2:a', 't', 100000, 100000)")
      .run();

    await migrate(db, '0002_trim.sql');

    const rows = (await db.prepare('SELECT cart_key, in_cart, unit_price FROM cart_items ORDER BY cart_key').all<{ cart_key: string; in_cart: number; unit_price: number }>()).results;
    assert.deepEqual(rows.map(r => [r.cart_key, r.in_cart, r.unit_price]), [['1:2:a', 1, 100000], ['1:2:b', 0, 100000]]);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM price_history').first<{ n: number }>())?.n, 1);

    const columns = (await db.prepare("SELECT name FROM pragma_table_info('cart_items')").all<{ name: string }>()).results.map(c => c.name);
    for (const dropped of ['is_inactive', 'is_hidden', 'original_price', 'first_unit_price', 'max_effective_price']) {
      assert.equal(columns.includes(dropped), false, dropped);
    }
    assert.equal(columns.includes('first_effective_price'), true);
  } finally {
    await mf.dispose();
  }
});

test('cảnh báo đồng bộ gửi lại khi Telegram lỗi, chỉ báo một lần và báo hồi phục', async () => {
  const { mf, db } = await openDb();
  try {
    await migrateAll(db);
    const now = Date.parse('2026-11-07T12:00:00Z');
    const sync = (at: number) => recordSyncRun(db, {
      syncedAt: new Date(at).toISOString(), source: 'chrome-alarm', totalInCart: 1,
      changedCount: 0, alertsSent: 0, telegramOk: null, note: '',
    });
    const env: Env = { DB: db, TELEGRAM_BOT_TOKEN: 'fake', TELEGRAM_CHAT_ID: '-1' };
    const messages: string[] = [];
    const fakeFetch: typeof fetch = async (_input, init) => {
      messages.push(JSON.parse(String(init?.body)).text);
      return Response.json({ ok: true });
    };
    await sync(now - 8 * 3_600_000);
    await checkSyncHealth(env, now, fakeFetch);
    assert.equal(messages.length, 0);
    const later = now + 3_600_000;
    await assert.rejects(checkSyncHealth(env, later, async () => Response.json({ ok: false })));
    await checkSyncHealth(env, later, fakeFetch);
    await checkSyncHealth(env, later + 1000, fakeFetch);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /Đã 9 giờ/);
    await sync(later);
    await checkSyncHealth(env, later + 1000, fakeFetch);
    await checkSyncHealth(env, later + 2000, fakeFetch);
    assert.equal(messages.length, 2);
    assert.match(messages[1], /đã đồng bộ lại/);
  } finally {
    await mf.dispose();
  }
});

test('từ chối dữ liệu sai trước khi ghi; giỏ giảm mạnh cần xác nhận; link Shopee dựng từ mã', async () => {
  const { mf, db } = await openDb();
  try {
    await migrateAll(db);
    const env: Env = { DB: db };
    const cart = Array.from({ length: 5 }, (_, i) => snapshotItem({ shopId: '1', itemId: String(i + 1) }));
    const sync = (body: unknown, headers: HeadersInit = writeHeaders) => handleApiRequest(new Request(
      'https://example.com/api/sync/cart', { method: 'POST', headers, body: JSON.stringify(body) }
    ), env);
    const state = async () => {
      const response = await handleApiRequest(new Request('https://example.com/api/state'), env);
      return await response.json() as AppStateResponse;
    };
    assert.equal((await sync({ items: cart }, { 'content-type': 'text/plain' })).status, 403);
    assert.equal((await sync({ items: cart }, { 'x-shopee-tracker': '1' })).status, 415);
    assert.equal((await sync({ items: [{ ...cart[0], unitPrice: '1' }] })).status, 400);
    assert.equal((await sync({ items: cart, extra: 'x'.repeat(512 * 1024) })).status, 413);
    assert.equal((await sync(null)).status, 400);
    const broken = await handleApiRequest(new Request('https://example.com/api/sync/cart', {
      method: 'POST', headers: writeHeaders, body: '{"items":',
    }), env);
    assert.equal(broken.status, 400);
    assert.equal(broken.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal((await handleApiRequest(new Request('https://example.com/api/items/%E0%A4%A/history'), env)).status, 400);
    assert.equal((await sync({ items: cart.map(item => ({ ...item, productUrl: 'https://example.com/phish' })) })).status, 200);
    assert.equal((await state()).items[0].productUrl, 'https://shopee.vn/product/1/1');
    assert.equal((await sync({ items: [cart[0]] })).status, 409);
    assert.equal((await state()).items.length, 5);
    assert.equal((await sync({ items: [cart[1]] })).status, 409);
    assert.equal((await sync({ items: [cart[1]] })).status, 200);
    assert.equal((await state()).items.length, 1);
    assert.equal((await sync({ items: [], cartEmpty: true })).status, 409);
    assert.equal((await sync({ items: [], cartEmpty: true })).status, 200);
    assert.equal((await state()).items.length, 0);
  } finally {
    await mf.dispose();
  }
});

test('mốc giá giỏ từ lịch sử, Live có giãn cách riêng, biểu đồ lấy điểm mới nhất', async () => {
  const { mf, db } = await openDb();
  try {
    await migrate(db, '0001_init.sql');
    await migrate(db, '0002_trim.sql');
    const key = '254666730:28016604566:xanh min';
    const first = '2026-11-06T00:00:00.000Z';
    await db.prepare(`INSERT INTO cart_items (cart_key, shop_id, item_id, title, variation, product_url, unit_price,
      streaming_price, effective_price, first_effective_price, min_effective_price, first_seen_at)
      VALUES (?, '254666730', '28016604566', 'Cốc', 'Xanh min', '', 389000, 359000, 359000, 359000, 359000, ?)`)
      .bind(key, first).run();
    await db.prepare('INSERT INTO price_history (cart_key, recorded_at, unit_price, streaming_price) VALUES (?, ?, 389000, 359000)')
      .bind(key, first).run();
    await migrate(db, '0003_tracker_state.sql');
    await migrate(db, '0004_price_baselines.sql');
    const sync = async (unitPrice: number, streamingPrice: number | null, hour: number) => {
      const at = new Date(Date.parse(first) + hour * 3_600_000).toISOString();
      const run = await upsertCartSnapshot(db, [snapshotItem({ unitPrice, streamingPrice })], at);
      assert.ok(run);
      await markAlertsDelivered(db, run.alerts, at);
      return run.alerts.flatMap(alert => alert.deals.map(deal => deal.kind));
    };
    assert.deepEqual(await sync(389_000, 359_000, 1), ['live']);
    assert.deepEqual(await sync(389_000, null, 2), []);
    assert.deepEqual(await sync(389_000, 359_000, 3), []);
    assert.deepEqual(await sync(389_000, 359_000, 14), ['live']);
    assert.deepEqual(await sync(350_000, null, 15), ['low']);
    assert.deepEqual(await sync(350_000, null, 16), []);
    assert.deepEqual(await sync(350_000, 300_000, 27), ['live']);
    assert.deepEqual(await sync(350_000, 300_000, 28), []);
    await db.prepare(`WITH RECURSIVE prices(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM prices WHERE n<250)
      INSERT INTO price_history (cart_key, recorded_at, unit_price) SELECT ?, ?, 400000+n FROM prices`)
      .bind(key, first).run();
    const history = await handleApiRequest(new Request('https://example.com/api/items/' + encodeURIComponent(key) + '/history'), { DB: db });
    const { points } = await history.json() as { points: Array<{ unitPrice: number }> };
    assert.equal(points.length, 200);
    assert.equal(points[0].unitPrice, 400_051);
    assert.equal(points.at(-1)?.unitPrice, 400_250);
  } finally {
    await mf.dispose();
  }
});

test('Telegram chia đủ 11 món, chỉ đánh dấu món đã gửi và thử lại tin lỗi', async () => {
  const { mf, db } = await openDb();
  try {
    await migrateAll(db);
    const env: Env = { DB: db, TELEGRAM_BOT_TOKEN: 'fake', TELEGRAM_CHAT_ID: '-1' };
    const messages: string[] = [];
    let fail = false;
    const telegram: typeof fetch = async (_input, init) => {
      const { text } = JSON.parse(String(init?.body)) as { text: string };
      messages.push(text);
      if (fail || messages.length === 2) return Response.json({ ok: false, parameters: { retry_after: 420 } }, { status: 429 });
      return Response.json({ ok: true });
    };
    const sync = async (price: number) => {
      const items = Array.from({ length: 11 }, (_, i) => snapshotItem({
        shopId: '1', itemId: String(i + 1), title: 'Món mẫu ' + (i + 1), unitPrice: price,
      }));
      const result = await handleApiRequest(new Request('https://example.test/api/sync/cart', {
        method: 'POST', headers: writeHeaders, body: JSON.stringify({ items }),
      }), env, telegram);
      assert.equal(result.status, 200);
      return await result.json() as { alertsSent: number; run: { syncedAt: string; note: string; telegramOk: boolean } };
    };
    const marked = () => db.prepare('SELECT count(*) AS n FROM cart_items WHERE last_low_alert_price = 220000').first<number>('n');
    await sync(300_000);
    const sale = await sync(220_000);
    assert.equal(sale.alertsSent, 10);
    assert.equal(sale.run.telegramOk, false);
    assert.match(sale.run.note, /1 món chờ gửi/);
    assert.equal(await marked(), 10);
    assert.equal(messages.length, 2);
    assert.doesNotMatch(messages[0], /Món mẫu 11</);
    assert.match(messages[1], /Món mẫu 11</);
    const now = Date.parse(sale.run.syncedAt);
    await retryPendingAlerts(env, now + 6 * 60_000, telegram);
    assert.equal(messages.length, 2);
    await retryPendingAlerts(env, now + 7 * 60_000, telegram);
    assert.equal(messages.length, 3);
    assert.match(messages[2], /Món mẫu 11</);
    assert.equal(await marked(), 11);
    assert.equal(await db.prepare('SELECT count(*) AS n FROM alert_outbox').first<number>('n'), 0);

    fail = true;
    const expired = await sync(180_000);
    const sends = messages.length;
    await retryPendingAlerts(env, Date.parse(expired.run.syncedAt) + 30 * 60_000, telegram);
    assert.equal(messages.length, sends);
    assert.equal(await db.prepare('SELECT count(*) AS n FROM alert_outbox').first<number>('n'), 0);
    assert.equal(await marked(), 11);
  } finally {
    await mf.dispose();
  }
});

test('giá canh không báo lại khi giá bật lên mà vẫn dưới ngưỡng', async () => {
  const { mf, db } = await openDb();
  try {
    await migrateAll(db);
    const original = await upsertCartSnapshot(db, [snapshotItem({ unitPrice: 300_000 })]);
    assert.ok(original);
    const key = '254666730:28016604566:xanh min';
    await db.prepare('UPDATE cart_items SET target_price = 300000 WHERE cart_key = ?').bind(key).run();
    const first = await upsertCartSnapshot(db, [snapshotItem({ unitPrice: 200_000 })]);
    assert.ok(first);
    await markAlertsDelivered(db, first.alerts, first.syncedAt);
    const rebound = await upsertCartSnapshot(db, [snapshotItem({ unitPrice: 230_000 })]);
    assert.ok(rebound);
    assert.equal(rebound.alerts.some(alert => alert.deals.some(deal => deal.kind === 'target')), false);
    await upsertCartSnapshot(db, [snapshotItem({ unitPrice: 320_000 })]);
    const back = await upsertCartSnapshot(db, [snapshotItem({ unitPrice: 295_000 })]);
    assert.ok(back);
    assert.equal(back.alerts.some(alert => alert.deals.some(deal => deal.kind === 'target')), true);
  } finally {
    await mf.dispose();
  }
});

test('bản chụp thiếu một món chưa làm mất món đó cho đến lần xác nhận', async () => {
  const { mf, db } = await openDb();
  try {
    await migrateAll(db);
    const cart = Array.from({ length: 5 }, (_, i) => snapshotItem({ shopId: '1', itemId: String(i + 1) }));
    const visible = () => db.prepare('SELECT count(*) AS n FROM cart_items WHERE in_cart = 1').first<number>('n');
    assert.ok(await upsertCartSnapshot(db, cart));
    assert.equal(await upsertCartSnapshot(db, cart.slice(0, 4)), null);
    assert.equal(await visible(), 5);
    assert.ok(await upsertCartSnapshot(db, cart));
    assert.equal(await upsertCartSnapshot(db, cart.slice(0, 4)), null, 'Lượt đủ món phải hủy xác nhận cũ');
    assert.ok(await upsertCartSnapshot(db, cart.slice(0, 4)));
    assert.equal(await visible(), 4);
  } finally {
    await mf.dispose();
  }
});

test('lỗi giữa bản chụp không ghi giá nửa chừng vào giỏ và lịch sử', async () => {
  const { mf, db } = await openDb();
  try {
    await migrateAll(db);
    const cart = Array.from({ length: 45 }, (_, i) => snapshotItem({ shopId: '1', itemId: String(i + 1), unitPrice: 200_000 }));
    await upsertCartSnapshot(db, cart);
    await db.prepare(`CREATE TRIGGER reject_last BEFORE UPDATE ON cart_items
      WHEN NEW.item_id = '45' BEGIN SELECT RAISE(ABORT, 'fixture failed'); END`).run();
    await assert.rejects(upsertCartSnapshot(db, cart.map(item => ({ ...item, unitPrice: 150_000 })), new Date().toISOString(), true), /fixture failed/);
    assert.equal(await db.prepare('SELECT count(*) AS n FROM cart_items WHERE unit_price = 150000').first<number>('n'), 0);
    assert.equal(await db.prepare('SELECT count(*) AS n FROM price_history').first<number>('n'), 45);
    assert.equal(await db.prepare('SELECT count(*) AS n FROM alert_outbox').first<number>('n'), 0);
  } finally {
    await mf.dispose();
  }
});
