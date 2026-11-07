import type { CartSnapshotItem } from '../lib/model.ts';
import { buildCartKey } from '../lib/model.ts';

export class InputError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function requireWriteHeader(request: Request): void {
  if (request.headers.get('x-shopee-tracker') !== '1') throw new InputError('Thiếu tiêu đề X-Shopee-Tracker', 403);
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new InputError('Yêu cầu phải có định dạng JSON', 415);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new InputError('Thiếu dữ liệu JSON');
  const decoder = new TextDecoder();
  let bytes = 0;
  let raw = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 512 * 1024) {
      await reader.cancel();
      throw new InputError('Dữ liệu gửi lên quá lớn', 413);
    }
    raw += decoder.decode(value, { stream: true });
  }
  try {
    const data: unknown = JSON.parse(raw + decoder.decode());
    if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
  } catch {
    // Trả cùng một lỗi cho JSON hỏng và JSON không phải object.
  }
  throw new InputError('Dữ liệu JSON không hợp lệ');
}

export function isPrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2_000_000_000;
}

export function parseSnapshot(body: Record<string, unknown>): CartSnapshotItem[] {
  if (!Array.isArray(body.items) || body.items.length > 200 || (!body.items.length && body.cartEmpty !== true)) {
    throw new InputError('Bản chụp giỏ hàng không hợp lệ');
  }
  const keys = new Set<string>();
  return body.items.map((entry: unknown, cartOrder) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new InputError('Dòng sản phẩm không hợp lệ');
    const row = entry as Record<string, unknown>;
    const field = (key: string, max: number): string => {
      const value = row[key];
      if (typeof value !== 'string' || value.length > max) throw new InputError('Trường sản phẩm không hợp lệ: ' + key);
      return value.trim();
    };
    const shopId = field('shopId', 24);
    const itemId = field('itemId', 24);
    const title = field('title', 600);
    const variation = field('variation', 160);
    const { unitPrice, streamingPrice } = row;
    if (!/^\d+$/.test(shopId) || !/^\d+$/.test(itemId) || !title || !isPrice(unitPrice)
        || (streamingPrice !== null && !isPrice(streamingPrice))) {
      throw new InputError('Mã, tên hoặc giá sản phẩm không hợp lệ');
    }
    const key = buildCartKey(shopId, itemId, variation);
    if (keys.has(key)) throw new InputError('Bản chụp có sản phẩm trùng phân loại');
    keys.add(key);
    const image = field('imageUrl', 1024);
    const url = URL.parse(image);
    const imageUrl = url?.protocol === 'https:' && url.hostname.endsWith('.susercontent.com') && !url.username && !url.password
      ? url.href
      : '';
    return {
      shopId, itemId, title, variation, cartOrder, unitPrice, streamingPrice, imageUrl,
      productUrl: 'https://shopee.vn/product/' + shopId + '/' + itemId,
      shopName: field('shopName', 200),
      voucherHint: field('voucherHint', 240),
      flashSaleText: field('flashSaleText', 240),
      cartDropBadge: field('cartDropBadge', 240),
    };
  });
}
