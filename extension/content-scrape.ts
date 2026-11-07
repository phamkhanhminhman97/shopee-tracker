import { extractShopeeCartFromDom } from '../src/lib/cart-parser.ts';

interface ScrapeResult {
  ok: boolean;
  blocked?: boolean;
  cartEmpty?: boolean;
  error?: string;
  items?: ReturnType<typeof extractShopeeCartFromDom>;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const rowCount = () =>
  Array.from(document.querySelectorAll('h4')).filter(h => (h.textContent || '').trim() === 'cart_accessibility_item')
    .length;

function pageProblem(): ScrapeResult | null {
  if (location.pathname.startsWith('/verify')) {
    return { ok: false, blocked: true, error: 'Shopee đang yêu cầu xác minh (CAPTCHA). Hãy mở tab Shopee và hoàn tất xác minh.' };
  }
  if (location.pathname.startsWith('/buyer/login')) {
    return { ok: false, error: 'Chrome đang đăng xuất khỏi Shopee. Hãy đăng nhập lại.' };
  }
  return null;
}

// Giỏ hàng nạp dần: chờ tới khi số dòng giữ nguyên hai lần đo liên tiếp rồi mới đọc.
async function scrapeCart(): Promise<ScrapeResult> {
  let last = -1;
  let stable = 0;
  for (let i = 0; i < 40 && stable < 2; i++) {
    const problem = pageProblem();
    if (problem) return problem;
    const count = rowCount();
    stable = count > 0 && count === last ? stable + 1 : 0;
    last = count;
    if (stable < 2) await sleep(500);
  }

  const problem = pageProblem();
  if (problem) return problem;
  if (location.pathname !== '/cart') return { ok: false, error: 'Shopee không mở được trang giỏ hàng.' };
  if (last <= 0) {
    const empty = location.pathname === '/cart' &&
      /giỏ hàng của bạn còn trống|shopping cart is empty/i.test(document.body?.innerText || '');
    if (empty) return { ok: true, items: [], cartEmpty: true };
    return { ok: false, error: 'Chưa thấy danh sách sản phẩm trên trang giỏ hàng.' };
  }
  if (stable < 2) return { ok: false, error: 'Giỏ hàng vẫn đang tải. Hãy quét lại.' };
  const stats = { activeRows: 0 };
  const items = extractShopeeCartFromDom(document, window, stats);
  if (stats.activeRows > 0 && (!items.length || items.length * 5 < stats.activeRows * 4)) {
    return { ok: false, error: 'Chỉ đọc được ' + items.length + '/' + stats.activeRows + ' món. Giữ lại giỏ đã lưu.' };
  }
  return { ok: true, items, cartEmpty: stats.activeRows === 0 };
}

(window as unknown as { __scrapeShopeeCart: () => Promise<ScrapeResult> }).__scrapeShopeeCart = scrapeCart;
