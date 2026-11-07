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

function dealOptions(item: TrackedItem): Deal[] {
  const hasLive = item.streamingPrice !== null && item.streamingPrice > 0 && item.streamingPrice < item.unitPrice;
  const liveSaving = hasLive ? item.unitPrice - (item.streamingPrice as number) : 0;
  const livePct = (liveSaving / item.unitPrice) * 100;
  const lowSaving = Math.max(0, item.firstUnitPrice - item.unitPrice);
  const lowPct = (lowSaving / item.firstUnitPrice) * 100;

  const channel = hasLive ? 'Shopee Live' : 'Giỏ thường';
  const savings = Math.max(lowSaving, liveSaving);
  const options: Deal[] = [];
  const add = (kind: Deal['kind'], reason: string) => options.push({ isWorth: kind !== null, kind, reason, channel, savings });
  if (item.targetPrice !== null && item.effectivePrice <= item.targetPrice) {
    add('target', 'Đã chạm giá canh ' + formatVnd(item.targetPrice));
  }
  if (item.unitPrice <= item.minUnitPrice && lowSaving >= LOW_MIN_SAVING && lowPct >= LOW_MIN_PCT) {
    add('low', 'Đáy giá giỏ, rẻ hơn ' + formatVnd(lowSaving) + ' (' + Math.round(lowPct) + '%) so với lúc bắt đầu canh');
  }
  if (liveSaving >= LIVE_MIN_SAVING && livePct >= LIVE_MIN_PCT) {
    add('live', 'Giá Live rẻ hơn ' + formatVnd(liveSaving) + ' (' + Math.round(livePct) + '%)');
  }
  if (!options.length) add(null, '');
  return options;
}

export function evaluateDeal(item: TrackedItem): Deal {
  return dealOptions(item)[0];
}

export function eligibleDeals(item: TrackedItem, now: number): Deal[] {
  return dealOptions(item).filter(deal => shouldAlert(item, deal, now));
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
