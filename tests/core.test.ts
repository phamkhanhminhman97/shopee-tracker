import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCartRowLines, type RawCartRow } from '../src/lib/cart-parser.ts';
import { evaluateDeal } from '../src/lib/deal.ts';
import {
  buildCartKey,
  computeEffectivePrice,
  formatVnd,
  localizeShopeeNote,
  type TrackedItem,
} from '../src/lib/model.ts';

function row(overrides: Partial<RawCartRow> = {}): RawCartRow {
  return {
    shopId: '1103428920',
    itemId: '55354657234',
    shopName: 'MallBaseus Official Mall Vietnam',
    productHref: '/Tai-Nghe-Baseus-i.1103428920.55354657234?xptdk=abc',
    title: 'Tai Nghe Baseus Bass BS2 Lite',
    imageUrl: 'https://down-vn.img.susercontent.com/file/img1',
    lines: [
      'cart_accessibility_item',
      'Tai Nghe Baseus Bass BS2 Lite',
      'Flash Sale ends at 17:00:00',
      'Variations:',
      'Đen',
      '389.000₫',
      'Streaming Price at 359.000₫',
      '389.000₫',
      'Total price: 389.000₫',
      'Delete',
    ],
    struckPrices: [],
    voucherHint: 'Up to 60k₫ off voucher available',
    inInactiveSection: false,
    cartOrder: 0,
    ...overrides,
  };
}

function tracked(overrides: Partial<TrackedItem> = {}): TrackedItem {
  const unitPrice = overrides.unitPrice ?? 500_000;
  const streamingPrice = overrides.streamingPrice ?? null;
  const effectivePrice = computeEffectivePrice(unitPrice, streamingPrice);
  return {
    cartKey: '1:2:default',
    shopId: '1',
    itemId: '2',
    shopName: 'Shop',
    title: 'Sản phẩm',
    variation: '',
    productUrl: 'https://shopee.vn/x-i.1.2',
    imageUrl: '',
    cartOrder: 0,
    unitPrice,
    streamingPrice,
    effectivePrice,
    firstEffectivePrice: effectivePrice,
    minEffectivePrice: effectivePrice,
    targetPrice: null,
    voucherHint: '',
    flashSaleText: '',
    cartDropBadge: '',
    alertMuted: false,
    lastAlertedPrice: null,
    firstSeenAt: '2026-11-07T08:00:00.000Z',
    ...overrides,
  };
}

test('đọc đúng giá thường, giá Live, phân loại và ghi chú từ dòng chữ thật của giỏ hàng', () => {
  const parsed = parseCartRowLines(row());
  assert.ok(parsed);
  assert.equal(parsed.shopName, 'Baseus Official Mall Vietnam');
  assert.equal(parsed.variation, 'Đen');
  assert.equal(parsed.unitPrice, 389_000);
  assert.equal(parsed.streamingPrice, 359_000);
  assert.equal(parsed.flashSaleText, 'Flash Sale ends at 17:00:00');
  assert.equal(parsed.productUrl, 'https://shopee.vn/Tai-Nghe-Baseus-i.1103428920.55354657234');
});

test('bỏ qua hàng không còn bán và gỡ nhãn Add-On khỏi tên', () => {
  assert.equal(parseCartRowLines(row({ inInactiveSection: true })), null);
  assert.equal(parseCartRowLines(row({ lines: ['INVALID', '57.140₫'] })), null);
  assert.equal(parseCartRowLines(row({ title: 'Add-OnTúi Baseus mini' }))?.title, 'Túi Baseus mini');
});

test('giá hiện hành là giá không bị gạch ngang', () => {
  const lines = ['Variations:', 'Xanh', '259.000₫', '199.000₫', '199.000₫', 'Total price: 199.000₫'];
  assert.equal(parseCartRowLines(row({ lines, struckPrices: ['259.000₫'] }))?.unitPrice, 199_000);
  assert.equal(parseCartRowLines(row({ lines }))?.unitPrice, 199_000);
});

test('hai phân loại của cùng một sản phẩm có khoá khác nhau', () => {
  assert.notEqual(buildCartKey('9', '1', 'Nâu xám 4 lớp'), buildCartKey('9', '1', 'Xanh bơ 4 lớp'));
  assert.equal(buildCartKey('9', '1', 'Nâu  xám 4 lớp'), buildCartKey('9', '1', ' nâu xám 4 lớp '));
});

test('chỉ báo giảm giá thật: bỏ qua Live rẻ hơn 1.000₫, bắt giá Live giảm sâu, giá canh và đáy mới', () => {
  assert.equal(evaluateDeal(tracked({ unitPrice: 317_000, streamingPrice: 316_000 })).isWorth, false);

  const live = evaluateDeal(tracked({ unitPrice: 529_000, streamingPrice: 398_000 }));
  assert.equal(live.isWorth, true);
  assert.equal(live.channel, 'Shopee Live');
  assert.equal(live.savings, 131_000);

  const target = evaluateDeal(tracked({ unitPrice: 300_000, targetPrice: 300_000 }));
  assert.equal(target.isWorth, true);
  assert.match(target.reason, /giá canh/);

  const low = evaluateDeal(tracked({ unitPrice: 160_000, firstEffectivePrice: 200_000, minEffectivePrice: 160_000 }));
  assert.equal(low.isWorth, true);
  assert.match(low.reason, /Đáy mới/);

  assert.equal(
    evaluateDeal(tracked({ unitPrice: 195_000, firstEffectivePrice: 200_000, minEffectivePrice: 195_000 })).isWorth,
    false
  );
});

test('dịch ghi chú tiếng Anh của Shopee và định dạng tiền', () => {
  assert.equal(localizeShopeeNote('Up to 60k₫ off voucher available'), 'Voucher shop giảm đến 60k₫');
  assert.equal(localizeShopeeNote('Flash Sale ends at 17:00:00'), 'Flash Sale đến 17:00');
  assert.equal(localizeShopeeNote('13% cheaper since added to cart'), 'Rẻ hơn 13% so với lúc thêm vào giỏ');
  assert.equal(localizeShopeeNote('Ghi chú lạ'), 'Ghi chú lạ');
  assert.equal(formatVnd(529_000), '529.000₫');
});
