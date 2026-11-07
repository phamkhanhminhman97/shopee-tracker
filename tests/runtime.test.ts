import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { handleApiRequest } from '../src/worker/index.ts';
import type { Env } from '../src/worker/env.d.ts';

async function openDb() {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      compatibilityDate: '2026-11-07',
      script: 'export default { fetch() { return new Response("ok"); } }',
      d1Databases: ['DB'],
    })
  );
  return { mf, db: await mf.getD1Database('DB') };
}

async function migrate(db: D1Database, file: string) {
  const sql = readFileSync(resolve(process.cwd(), 'migrations', file), 'utf8');
  for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
}

const snapshotItem = (overrides: Record<string, unknown> = {}) => ({
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

test('đồng bộ giỏ hàng: báo Telegram một lần khi giá giảm sâu, không báo lặp, món rời giỏ biến mất', async () => {
  const { mf, db } = await openDb();
  try {
    await migrate(db, '0001_init.sql');
    await migrate(db, '0002_trim.sql');

    const messages: string[] = [];
    const fakeFetch: typeof fetch = async (_input, init) => {
      messages.push((JSON.parse(String(init?.body)) as { text: string }).text);
      return Response.json({ ok: true, result: { message_id: 100 + messages.length } });
    };
    const env: Env = { DB: db, TELEGRAM_BOT_TOKEN: 'token', TELEGRAM_CHAT_ID: '-1', APP_PUBLIC_URL: 'https://shopee.example' };
    const call = (path: string, init?: RequestInit) =>
      handleApiRequest(new Request('https://shopee.example' + path, init), env, fakeFetch);
    const sync = async (items: unknown[]) =>
      (await (await call('/api/sync/cart', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'test', items }),
      })).json()) as { ok: boolean; alertsSent: number; run: { totalInCart: number; changedCount: number } };

    const first = await sync([snapshotItem()]);
    assert.equal(first.alertsSent, 0);
    assert.equal(first.run.changedCount, 1);

    const drop = await sync([snapshotItem({ unitPrice: 159_000 })]);
    assert.equal(drop.alertsSent, 1);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /Đáy mới/);
    assert.equal(messages[0].includes('—'), false);

    assert.equal((await sync([snapshotItem({ unitPrice: 159_000 })])).alertsSent, 0);
    assert.equal(messages.length, 1);

    const other = snapshotItem({ shopId: '1', itemId: '2', variation: '', title: 'Món khác', unitPrice: 100_000 });
    await sync([other]);
    const state = (await (await call('/api/state')).json()) as { items: Array<{ title: string }>; lastSyncedAt: string };
    assert.deepEqual(state.items.map(i => i.title), ['Món khác']);
    assert.ok(state.lastSyncedAt);

    const key = encodeURIComponent('1:2:default');
    const patched = await call('/api/items/' + key, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetPrice: 120_000, alertMuted: true }),
    });
    assert.equal(patched.status, 200);
    assert.equal((await call('/api/items/' + key, { method: 'PATCH', body: JSON.stringify({ targetPrice: -5 }) })).status, 400);
    assert.equal((await call('/api/items/khong-co', { method: 'PATCH', body: '{}' })).status, 404);
    assert.equal((await call('/api/sync/cart', { method: 'POST', body: JSON.stringify({ items: [] }) })).status, 400);

    const test = await call('/api/telegram/test', { method: 'POST' });
    assert.equal(test.status, 200);
    assert.equal(messages.length, 2);
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
