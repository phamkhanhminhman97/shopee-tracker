import { evaluateDeal, shouldAlert } from '../lib/deal.ts';
import {
  buildCartKey,
  computeEffectivePrice,
  type AppStateResponse,
  type CartSnapshotItem,
  type PricePoint,
  type SyncRun,
  type TrackedItem,
  type UpdateItemPayload,
} from '../lib/model.ts';
import type { AlertCandidate } from './telegram.ts';

export function getTrackerState(db: D1Database, key: string): Promise<string | null> {
  return db.prepare('SELECT value FROM tracker_state WHERE key = ?').bind(key).first<string>('value');
}

export async function setTrackerState(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare('INSERT OR REPLACE INTO tracker_state (key, value) VALUES (?, ?)').bind(key, value).run();
}

export async function claimUntil(db: D1Database, key: string, value: string, now: number): Promise<boolean> {
  const result = await db.prepare(
    'INSERT INTO tracker_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(tracker_state.value AS INTEGER) <= ?'
  ).bind(key, value, now).run();
  return result.meta.changes === 1;
}

export async function releaseClaim(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare('DELETE FROM tracker_state WHERE key = ? AND value = ?').bind(key, value).run();
}

interface ItemRow {
  cart_key: string;
  shop_id: string;
  item_id: string;
  shop_name: string;
  title: string;
  variation: string;
  product_url: string;
  image_url: string;
  cart_order: number;
  unit_price: number;
  streaming_price: number | null;
  effective_price: number;
  first_effective_price: number;
  min_effective_price: number;
  first_unit_price: number;
  min_unit_price: number;
  min_streaming_price: number | null;
  target_price: number | null;
  voucher_hint: string;
  flash_sale_text: string;
  cart_drop_badge: string;
  in_cart: number;
  alert_muted: number;
  last_alerted_price: number | null;
  last_low_alert_price: number | null;
  last_live_alert_price: number | null;
  last_live_alert_at: string | null;
  first_seen_at: string;
}

interface RunRow {
  id: number;
  synced_at: string;
  source: string;
  total_in_cart: number;
  changed_count: number;
  alerts_sent: number;
  telegram_ok: number | null;
  note: string;
}

function toItem(row: ItemRow): TrackedItem {
  return {
    cartKey: row.cart_key,
    shopId: row.shop_id,
    itemId: row.item_id,
    shopName: row.shop_name,
    title: row.title,
    variation: row.variation,
    productUrl: 'https://shopee.vn/product/' + encodeURIComponent(row.shop_id) + '/' + encodeURIComponent(row.item_id),
    imageUrl: row.image_url,
    cartOrder: row.cart_order,
    unitPrice: row.unit_price,
    streamingPrice: row.streaming_price,
    effectivePrice: row.effective_price,
    firstEffectivePrice: row.first_effective_price,
    minEffectivePrice: row.min_effective_price,
    firstUnitPrice: row.first_unit_price || row.unit_price,
    minUnitPrice: row.min_unit_price || row.unit_price,
    minStreamingPrice: row.min_streaming_price,
    targetPrice: row.target_price,
    voucherHint: row.voucher_hint,
    flashSaleText: row.flash_sale_text,
    cartDropBadge: row.cart_drop_badge,
    alertMuted: row.alert_muted === 1,
    lastAlertedPrice: row.last_alerted_price,
    lastLowAlertPrice: row.last_low_alert_price,
    lastLiveAlertPrice: row.last_live_alert_price,
    lastLiveAlertAt: row.last_live_alert_at,
    firstSeenAt: row.first_seen_at,
  };
}

async function runBatched(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += 40) await db.batch(statements.slice(i, i + 40));
}

export async function getAppState(db: D1Database, telegramConfigured: boolean): Promise<AppStateResponse> {
  const [itemsRes, runsRes] = await Promise.all([
    db.prepare('SELECT * FROM cart_items WHERE in_cart = 1 ORDER BY cart_order').all<ItemRow>(),
    db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 10').all<RunRow>(),
  ]);
  const recentRuns: SyncRun[] = (runsRes.results ?? []).map(r => ({
    id: r.id,
    syncedAt: r.synced_at,
    source: r.source,
    totalInCart: r.total_in_cart,
    changedCount: r.changed_count,
    alertsSent: r.alerts_sent,
    telegramOk: r.telegram_ok === null ? null : r.telegram_ok === 1,
    note: r.note,
  }));
  return {
    items: (itemsRes.results ?? []).map(toItem),
    recentRuns,
    lastSyncedAt: recentRuns[0]?.syncedAt ?? null,
    telegramConfigured,
  };
}

export async function getItemHistory(db: D1Database, cartKey: string): Promise<PricePoint[]> {
  const res = await db
    .prepare('SELECT recorded_at, unit_price, streaming_price FROM price_history WHERE cart_key = ? ORDER BY id DESC LIMIT 200')
    .bind(cartKey)
    .all<{ recorded_at: string; unit_price: number; streaming_price: number | null }>();
  return (res.results ?? []).reverse().map(r => ({
    recordedAt: r.recorded_at,
    unitPrice: r.unit_price,
    streamingPrice: r.streaming_price,
    effectivePrice: computeEffectivePrice(r.unit_price, r.streaming_price),
  }));
}

export interface SyncResult {
  syncedAt: string;
  total: number;
  changed: number;
  alerts: AlertCandidate[];
}

// Bản chụp là toàn bộ giỏ đang bán: món vắng mặt được đánh dấu rời giỏ nhưng giữ lịch sử,
// món quay lại giỏ nối tiếp lịch sử cũ.
export async function upsertCartSnapshot(
  db: D1Database,
  snapshot: CartSnapshotItem[],
  now: string = new Date().toISOString()
): Promise<SyncResult | null> {
  const existing = new Map<string, ItemRow>();
  const legacyKeys = new Map<string, string>();
  for (const row of (await db.prepare('SELECT * FROM cart_items ORDER BY in_cart, cart_key').all<ItemRow>()).results ?? []) {
    existing.set(row.cart_key, row);
    legacyKeys.set(buildCartKey(row.shop_id, row.item_id, row.variation), row.cart_key);
  }

  const seen = new Map<string, CartSnapshotItem>();
  for (const item of snapshot) {
    const key = buildCartKey(item.shopId, item.itemId, item.variation);
    seen.set(existing.has(key) ? key : legacyKeys.get(key) ?? key, item);
  }

  const active = [...existing.values()].filter(row => row.in_cart === 1);
  const kept = active.filter(row => seen.has(row.cart_key)).length;
  const shrink = (active.length >= 5 && kept * 2 < active.length) || (active.length > 0 && seen.size === 0);
  const signature = shrink ? JSON.stringify([...seen.keys()].sort()) : '';
  const pending = await getTrackerState(db, 'pending_cart');
  const separator = pending?.indexOf('\n') ?? -1;
  const matches = pending && separator > 0 && pending.slice(separator + 1) === signature &&
    Date.parse(now) - Number(pending.slice(0, separator)) <= 60 * 60_000;
  if (shrink && !matches) {
    await setTrackerState(db, 'pending_cart', Date.parse(now) + '\n' + signature);
    return null;
  }

  const statements: D1PreparedStatement[] = [];
  const alerts: AlertCandidate[] = [];
  let changed = 0;

  const recordPrice = (key: string, snap: CartSnapshotItem) =>
    db
      .prepare('INSERT INTO price_history (cart_key, recorded_at, unit_price, streaming_price) VALUES (?, ?, ?, ?)')
      .bind(key, now, snap.unitPrice, snap.streamingPrice);

  for (const [key, snap] of seen) {
    const effective = computeEffectivePrice(snap.unitPrice, snap.streamingPrice);
    const live = effective < snap.unitPrice ? effective : null;
    const old = existing.get(key);
    let tracked: TrackedItem;

    if (!old) {
      changed++;
      statements.push(
        db
          .prepare(
            'INSERT INTO cart_items (cart_key, shop_id, item_id, shop_name, title, variation, product_url, image_url, cart_order, unit_price, streaming_price, effective_price, first_effective_price, min_effective_price, first_unit_price, min_unit_price, min_streaming_price, voucher_hint, flash_sale_text, cart_drop_badge, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          )
          .bind(
            key, snap.shopId, snap.itemId, snap.shopName, snap.title, snap.variation, snap.productUrl, snap.imageUrl,
            snap.cartOrder, snap.unitPrice, snap.streamingPrice, effective, effective, effective,
            snap.unitPrice, snap.unitPrice, live,
            snap.voucherHint, snap.flashSaleText, snap.cartDropBadge, now
          ),
        recordPrice(key, snap)
      );
      tracked = {
        cartKey: key,
        shopId: snap.shopId,
        itemId: snap.itemId,
        shopName: snap.shopName,
        title: snap.title,
        variation: snap.variation,
        productUrl: snap.productUrl,
        imageUrl: snap.imageUrl,
        cartOrder: snap.cartOrder,
        unitPrice: snap.unitPrice,
        streamingPrice: snap.streamingPrice,
        effectivePrice: effective,
        firstEffectivePrice: effective,
        minEffectivePrice: effective,
        firstUnitPrice: snap.unitPrice,
        minUnitPrice: snap.unitPrice,
        minStreamingPrice: live,
        targetPrice: null,
        voucherHint: snap.voucherHint,
        flashSaleText: snap.flashSaleText,
        cartDropBadge: snap.cartDropBadge,
        alertMuted: false,
        lastAlertedPrice: null,
        lastLowAlertPrice: null,
        lastLiveAlertPrice: null,
        lastLiveAlertAt: null,
        firstSeenAt: now,
      };
    } else {
      if (old.unit_price !== snap.unitPrice || old.streaming_price !== snap.streamingPrice) {
        changed++;
        statements.push(recordPrice(key, snap));
      }
      // Giá tăng từ 5% so với mức đã báo thì xoá mốc đã báo, để lần giảm sau được báo lại.
      const lastAlerted =
        old.last_alerted_price !== null && effective >= Math.round(old.last_alerted_price * 1.05)
          ? null
          : old.last_alerted_price;
      const minPrice = Math.min(old.min_effective_price, effective);
      const firstUnit = old.first_unit_price || old.unit_price;
      const minUnit = Math.min(old.min_unit_price || old.unit_price, snap.unitPrice);
      const minLive = live === null ? old.min_streaming_price : Math.min(live, old.min_streaming_price ?? live);
      const lastLive = live === null ? null : old.last_live_alert_price;
      statements.push(
        db
          .prepare(
            'UPDATE cart_items SET shop_name = ?, title = ?, product_url = ?, image_url = ?, cart_order = ?, unit_price = ?, streaming_price = ?, effective_price = ?, min_effective_price = ?, first_unit_price = ?, min_unit_price = ?, min_streaming_price = ?, voucher_hint = ?, flash_sale_text = ?, cart_drop_badge = ?, last_alerted_price = ?, last_live_alert_price = ?, in_cart = 1 WHERE cart_key = ?'
          )
          .bind(
            snap.shopName || old.shop_name, snap.title || old.title, snap.productUrl, snap.imageUrl || old.image_url,
            snap.cartOrder, snap.unitPrice, snap.streamingPrice, effective, minPrice, firstUnit, minUnit, minLive,
            snap.voucherHint, snap.flashSaleText, snap.cartDropBadge, lastAlerted, lastLive, key
          )
      );
      tracked = {
        ...toItem(old),
        shopName: snap.shopName || old.shop_name,
        title: snap.title || old.title,
        productUrl: snap.productUrl,
        imageUrl: snap.imageUrl || old.image_url,
        cartOrder: snap.cartOrder,
        unitPrice: snap.unitPrice,
        streamingPrice: snap.streamingPrice,
        effectivePrice: effective,
        minEffectivePrice: minPrice,
        minUnitPrice: minUnit,
        minStreamingPrice: minLive,
        voucherHint: snap.voucherHint,
        flashSaleText: snap.flashSaleText,
        cartDropBadge: snap.cartDropBadge,
        lastAlertedPrice: lastAlerted,
        lastLiveAlertPrice: lastLive,
      };
    }

    const deal = evaluateDeal(tracked);
    if (shouldAlert(tracked, deal, Date.parse(now))) alerts.push({ item: tracked, deal });
  }

  for (const [key, row] of existing) {
    if (row.in_cart === 1 && !seen.has(key)) {
      statements.push(db.prepare('UPDATE cart_items SET in_cart = 0 WHERE cart_key = ?').bind(key));
    }
  }

  await runBatched(db, statements);
  if (pending) await setTrackerState(db, 'pending_cart', '');
  return { syncedAt: now, total: seen.size, changed, alerts };
}

export async function markAlertsDelivered(db: D1Database, alerts: AlertCandidate[], at: string): Promise<void> {
  await runBatched(
    db,
    alerts.map(({ item, deal }) => {
      if (deal.kind === 'low') return db.prepare('UPDATE cart_items SET last_low_alert_price = ? WHERE cart_key = ?')
        .bind(item.unitPrice, item.cartKey);
      if (deal.kind === 'live') return db.prepare('UPDATE cart_items SET last_live_alert_price = ?, last_live_alert_at = ? WHERE cart_key = ?')
        .bind(item.effectivePrice, at, item.cartKey);
      return db.prepare('UPDATE cart_items SET last_alerted_price = ? WHERE cart_key = ?').bind(item.effectivePrice, item.cartKey);
    })
  );
}

export async function recordSyncRun(db: D1Database, run: Omit<SyncRun, 'id'>): Promise<SyncRun> {
  const row = await db
    .prepare(
      'INSERT INTO sync_runs (synced_at, source, total_in_cart, changed_count, alerts_sent, telegram_ok, note) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id'
    )
    .bind(
      run.syncedAt, run.source, run.totalInCart, run.changedCount, run.alertsSent,
      run.telegramOk === null ? null : run.telegramOk ? 1 : 0, run.note
    )
    .first<{ id: number }>();
  return { id: row?.id ?? 0, ...run };
}

export async function updateItemSettings(
  db: D1Database,
  cartKey: string,
  payload: UpdateItemPayload
): Promise<boolean> {
  const row = await db.prepare('SELECT target_price, alert_muted FROM cart_items WHERE cart_key = ?').bind(cartKey)
    .first<{ target_price: number | null; alert_muted: number }>();
  if (!row) return false;

  const targetPrice = payload.targetPrice !== undefined ? payload.targetPrice : row.target_price;
  const alertMuted = payload.alertMuted !== undefined ? (payload.alertMuted ? 1 : 0) : row.alert_muted;
  // Đổi giá canh thì xoá mốc đã báo để lần chạm mới được báo.
  const targetChanged = targetPrice !== row.target_price;
  await db
    .prepare(
      'UPDATE cart_items SET target_price = ?, alert_muted = ?, last_alerted_price = CASE WHEN ? THEN NULL ELSE last_alerted_price END WHERE cart_key = ?'
    )
    .bind(targetPrice, alertMuted, targetChanged ? 1 : 0, cartKey)
    .run();
  return true;
}
