import { parseVndInteger, type CartSnapshotItem } from './model.ts';

export interface RawCartRow {
  shopId: string;
  itemId: string;
  shopName: string;
  productHref: string;
  title: string;
  imageUrl: string;
  lines: string[];
  struckPrices: string[];
  voucherHint: string;
  inInactiveSection: boolean;
  cartOrder: number;
}

const SHOP_BADGE = /^(Mall|Preferred Seller Plus|Preferred|Yêu thích\+|Yêu thích|Shopee Mall)\s*/i;
const PRODUCT_HREF = /-i\.(\d+)\.(\d+)/;

function absoluteProductUrl(href: string): string {
  const path = href.split('?')[0] || href;
  if (/^https?:\/\//.test(path)) return path;
  return 'https://shopee.vn' + (path.startsWith('/') ? '' : '/') + path;
}

// Hàng hết hàng hoặc ngưng bán (mục "Inactive" của giỏ) không được theo dõi.
export function parseCartRowLines(raw: RawCartRow): CartSnapshotItem | null {
  if (raw.inInactiveSection || !raw.shopId || !raw.itemId) return null;

  const lines = raw.lines.map(l => l.trim()).filter(Boolean);
  let variation = '';
  let streamingPrice: number | null = null;
  let flashSaleText = '';
  let cartDropBadge = '';
  const prices: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^(invalid|không hợp lệ|hết hàng|ngưng bán)$/i.test(line)) return null;

    if (/^(variations|phân loại hàng):?$/i.test(line)) {
      const next = lines[i + 1] || '';
      if (next && !/₫|^(total price|số tiền|delete|xóa)/i.test(next)) {
        variation = next;
        i++;
      }
      continue;
    }
    const inlineVariation = /^(?:variations|phân loại hàng):\s*(.+)$/i.exec(line);
    if (inlineVariation) {
      variation = inlineVariation[1].trim();
      continue;
    }

    const live = /(?:streaming price(?: at)?|giá live)[:\s]*([\d.,]+)/i.exec(line);
    if (live) {
      streamingPrice = parseVndInteger(live[1]);
      continue;
    }
    if (/flash sale/i.test(line)) {
      flashSaleText = line;
      continue;
    }
    if (/cheaper since added to cart|so với (?:lúc|khi) thêm vào giỏ/i.test(line)) {
      cartDropBadge = line;
      continue;
    }
    if (/^(?:₫\s*)?[\d.]+(?:,\d+)?\s*₫?$/.test(line) && line.includes('₫')) {
      const price = parseVndInteger(line);
      if (price !== null) prices.push(price);
    }
  }

  // Giá hiện hành là giá không bị gạch ngang. Nếu không đọc được kiểu gạch ngang,
  // dòng giá đầu lớn hơn dòng thứ hai (khi có từ 3 dòng giá) là giá gốc.
  const struck = raw.struckPrices.map(parseVndInteger).filter((p): p is number => p !== null);
  let unitPrice = prices.filter(p => !struck.includes(p))[0];
  if (struck.length === 0 && prices.length >= 3 && prices[0] > prices[1]) unitPrice = prices[1];
  if (!unitPrice || unitPrice <= 0) return null;

  return {
    shopId: raw.shopId,
    itemId: raw.itemId,
    shopName: raw.shopName.replace(SHOP_BADGE, '').trim(),
    title: raw.title.replace(/^Add-On\s*/i, '').trim(),
    variation: variation.trim(),
    productUrl: absoluteProductUrl(raw.productHref),
    imageUrl: raw.imageUrl.trim(),
    cartOrder: raw.cartOrder,
    unitPrice,
    streamingPrice,
    voucherHint: raw.voucherHint.trim(),
    flashSaleText,
    cartDropBadge,
  };
}

function textLines(el: Element): string[] {
  return ((el as HTMLElement).innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
}

export function extractShopeeCartFromDom(doc: Document, win?: Window): CartSnapshotItem[] {
  const items: CartSnapshotItem[] = [];
  let shopName = '';
  let shopVoucher = '';
  let inInactiveSection = false;

  for (const el of Array.from(doc.querySelectorAll('h3, h4, a[href]'))) {
    const tag = el.tagName.toUpperCase();
    const text = (el.textContent || '').trim();

    if (tag === 'H3') {
      if (/inactive items|sản phẩm không hoạt động/i.test(text)) {
        inInactiveSection = true;
        shopName = '';
        shopVoucher = '';
      } else if (/^shop section$/i.test(text) && el.parentElement) {
        shopVoucher =
          textLines(el.parentElement).find(l => /voucher available|off voucher|mã giảm.*shop/i.test(l)) || '';
      }
      continue;
    }

    if (tag === 'A') {
      if ((el.getAttribute('href') || '').includes('entryPoint=cart') && text) shopName = text;
      continue;
    }

    if (tag !== 'H4' || text !== 'cart_accessibility_item' || !el.parentElement) continue;
    const row = el.parentElement;
    const productLinks = Array.from(row.querySelectorAll('a[href]')).filter(a =>
      PRODUCT_HREF.test(a.getAttribute('href') || '')
    );
    const link = productLinks.find(a => (a.textContent || '').trim()) || productLinks[0];
    const href = link?.getAttribute('href') || '';
    const ids = PRODUCT_HREF.exec(href);
    if (!link || !ids) continue;

    const struckPrices: string[] = [];
    if (win) {
      for (const leaf of Array.from(row.querySelectorAll('del, s, span, div'))) {
        const leafText = (leaf.textContent || '').trim();
        if (leaf.children.length === 0 && leafText.includes('₫')) {
          const tagName = leaf.tagName.toUpperCase();
          if (tagName === 'DEL' || tagName === 'S' || win.getComputedStyle(leaf).textDecorationLine.includes('line-through')) {
            struckPrices.push(leafText);
          }
        }
      }
    }

    const parsed = parseCartRowLines({
      shopId: ids[1],
      itemId: ids[2],
      shopName,
      productHref: href,
      title: (link.textContent || '').trim() || link.getAttribute('title') || '',
      imageUrl: (row.querySelector('img[src*="susercontent.com"]') || row.querySelector('img[src]'))?.getAttribute('src') || '',
      lines: textLines(row),
      struckPrices,
      voucherHint: inInactiveSection ? '' : shopVoucher,
      inInactiveSection,
      cartOrder: items.length,
    });
    if (parsed) items.push(parsed);
  }
  return items;
}
