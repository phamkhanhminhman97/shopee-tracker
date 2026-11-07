export interface CartSnapshotItem {
  shopId: string;
  itemId: string;
  shopName: string;
  title: string;
  variation: string;
  productUrl: string;
  imageUrl: string;
  cartOrder: number;
  unitPrice: number;
  streamingPrice: number | null;
  voucherHint: string;
  flashSaleText: string;
  cartDropBadge: string;
}

export interface TrackedItem {
  cartKey: string;
  shopId: string;
  itemId: string;
  shopName: string;
  title: string;
  variation: string;
  productUrl: string;
  imageUrl: string;
  cartOrder: number;
  unitPrice: number;
  streamingPrice: number | null;
  effectivePrice: number;
  firstEffectivePrice: number;
  minEffectivePrice: number;
  targetPrice: number | null;
  voucherHint: string;
  flashSaleText: string;
  cartDropBadge: string;
  alertMuted: boolean;
  lastAlertedPrice: number | null;
  firstSeenAt: string;
}

export interface PricePoint {
  recordedAt: string;
  unitPrice: number;
  streamingPrice: number | null;
  effectivePrice: number;
}

export interface SyncRun {
  id: number;
  syncedAt: string;
  source: string;
  totalInCart: number;
  changedCount: number;
  alertsSent: number;
  telegramOk: boolean | null;
  note: string;
}

export interface AppStateResponse {
  items: TrackedItem[];
  recentRuns: SyncRun[];
  lastSyncedAt: string | null;
  telegramConfigured: boolean;
}

export interface UpdateItemPayload {
  targetPrice?: number | null;
  alertMuted?: boolean;
}

export function buildCartKey(shopId: string, itemId: string, variation: string): string {
  const norm = variation.trim().toLowerCase().replace(/\s+/g, ' ') || 'default';
  return shopId.trim() + ':' + itemId.trim() + ':' + norm;
}

export function computeEffectivePrice(unitPrice: number, streamingPrice: number | null): number {
  return streamingPrice !== null && streamingPrice > 0 ? Math.min(unitPrice, streamingPrice) : unitPrice;
}

const vndFormat = new Intl.NumberFormat('vi-VN');

export function formatVnd(amount: number): string {
  return vndFormat.format(Math.round(amount)) + '₫';
}

export function parseVndInteger(raw: string): number | null {
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) return null;
  const value = Number(digits);
  return Number.isFinite(value) && value > 0 && value <= 2_000_000_000 ? value : null;
}

const SHOPEE_NOTES: Array<[RegExp, (m: RegExpExecArray) => string]> = [
  [/up to\s+(.+?)\s+off voucher available/i, m => 'Voucher shop giảm đến ' + m[1]],
  [/flash sale ends at\s+(\d{1,2}:\d{2})/i, m => 'Flash Sale đến ' + m[1]],
  [/(\d+)%\s+cheaper since added to cart/i, m => 'Rẻ hơn ' + m[1] + '% so với lúc thêm vào giỏ'],
];

// Shopee hiển thị theo ngôn ngữ của tài khoản; ghi chú tiếng Anh được dịch lúc hiển thị.
export function localizeShopeeNote(raw: string): string {
  for (const [pattern, format] of SHOPEE_NOTES) {
    const match = pattern.exec(raw);
    if (match) return format(match);
  }
  return raw;
}
