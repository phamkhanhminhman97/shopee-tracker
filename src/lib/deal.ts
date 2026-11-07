import { formatVnd, type TrackedItem } from './model.ts';

export interface Deal {
  isWorth: boolean;
  kind: 'target' | 'low' | 'live' | null;
  reason: string;
  channel: 'Shopee Live' | 'Giỏ thường';
  savings: number;
}

// Shopee Live hay rẻ hơn đúng 1.000₫ chỉ để tạo cảm giác giảm giá: không đủ ngưỡng thì không báo.
const LIVE_MIN_SAVING = 20_000;
const LIVE_MIN_PCT = 7;
const LOW_MIN_SAVING = 10_000;
const LOW_MIN_PCT = 5;
const LIVE_COOLDOWN_MS = 12 * 3_600_000;

export function evaluateDeal(item: TrackedItem): Deal {
  const hasLive = item.streamingPrice !== null && item.streamingPrice > 0 && item.streamingPrice < item.unitPrice;
  const liveSaving = hasLive ? item.unitPrice - (item.streamingPrice as number) : 0;
  const livePct = (liveSaving / item.unitPrice) * 100;
  const lowSaving = Math.max(0, item.firstUnitPrice - item.unitPrice);
  const lowPct = (lowSaving / item.firstUnitPrice) * 100;

  let reason = '';
  let kind: Deal['kind'] = null;
  if (item.targetPrice !== null && item.effectivePrice <= item.targetPrice) {
    kind = 'target';
    reason = 'Đã chạm giá canh ' + formatVnd(item.targetPrice);
  } else if (item.unitPrice <= item.minUnitPrice && lowSaving >= LOW_MIN_SAVING && lowPct >= LOW_MIN_PCT) {
    kind = 'low';
    reason = 'Đáy giá giỏ, rẻ hơn ' + formatVnd(lowSaving) + ' (' + Math.round(lowPct) + '%) so với lúc bắt đầu canh';
  } else if (liveSaving >= LIVE_MIN_SAVING && livePct >= LIVE_MIN_PCT) {
    kind = 'live';
    reason = 'Giá Live rẻ hơn ' + formatVnd(liveSaving) + ' (' + Math.round(livePct) + '%)';
  }

  return {
    isWorth: reason !== '',
    kind,
    reason,
    channel: hasLive ? 'Shopee Live' : 'Giỏ thường',
    savings: Math.max(lowSaving, liveSaving),
  };
}

export function shouldAlert(item: TrackedItem, deal: Deal, now: number): boolean {
  if (item.alertMuted) return false;
  if (deal.kind === 'low') return item.lastLowAlertPrice === null || item.unitPrice < item.lastLowAlertPrice;
  if (deal.kind === 'live') {
    return (item.lastLiveAlertAt === null || now - Date.parse(item.lastLiveAlertAt) >= LIVE_COOLDOWN_MS)
      && (item.lastLiveAlertPrice === null || item.effectivePrice < item.lastLiveAlertPrice);
  }
  return deal.kind === 'target' && (item.lastAlertedPrice === null || item.effectivePrice < item.lastAlertedPrice);
}
