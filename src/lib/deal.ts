import { formatVnd, type TrackedItem } from './model.ts';

export interface Deal {
  isWorth: boolean;
  reason: string;
  channel: 'Shopee Live' | 'Giỏ thường';
  savings: number;
}

// Shopee Live hay rẻ hơn đúng 1.000₫ chỉ để tạo cảm giác giảm giá: không đủ ngưỡng thì không báo.
const LIVE_MIN_SAVING = 20_000;
const LIVE_MIN_PCT = 7;
const LOW_MIN_SAVING = 10_000;
const LOW_MIN_PCT = 5;

export function evaluateDeal(item: TrackedItem): Deal {
  const hasLive = item.streamingPrice !== null && item.streamingPrice > 0 && item.streamingPrice < item.unitPrice;
  const liveSaving = hasLive ? item.unitPrice - (item.streamingPrice as number) : 0;
  const livePct = (liveSaving / item.unitPrice) * 100;
  const lowSaving = Math.max(0, item.firstEffectivePrice - item.effectivePrice);
  const lowPct = (lowSaving / item.firstEffectivePrice) * 100;

  let reason = '';
  if (item.targetPrice !== null && item.effectivePrice <= item.targetPrice) {
    reason = 'Đã chạm giá canh ' + formatVnd(item.targetPrice);
  } else if (item.effectivePrice <= item.minEffectivePrice && lowSaving >= LOW_MIN_SAVING && lowPct >= LOW_MIN_PCT) {
    reason = 'Đáy mới, rẻ hơn ' + formatVnd(lowSaving) + ' (' + Math.round(lowPct) + '%) so với lúc bắt đầu canh';
  } else if (liveSaving >= LIVE_MIN_SAVING && livePct >= LIVE_MIN_PCT) {
    reason = 'Giá Live rẻ hơn ' + formatVnd(liveSaving) + ' (' + Math.round(livePct) + '%)';
  }

  return {
    isWorth: reason !== '',
    reason,
    channel: hasLive ? 'Shopee Live' : 'Giỏ thường',
    savings: Math.max(lowSaving, liveSaving),
  };
}

export function shouldAlert(item: TrackedItem, deal: Deal): boolean {
  return (
    deal.isWorth &&
    !item.alertMuted &&
    (item.lastAlertedPrice === null || item.effectivePrice < item.lastAlertedPrice)
  );
}
