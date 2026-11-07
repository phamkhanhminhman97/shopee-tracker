import { extractShopeeCartFromDom } from '../src/lib/cart-parser.ts';

interface ScrapeResult {
  ok: boolean;
  blocked?: boolean;
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
  if (last <= 0) {
    const empty = /giỏ hàng của bạn còn trống|shopping cart is empty/i.test(document.body?.innerText || '');
    return { ok: false, error: empty ? 'Giỏ hàng Shopee đang trống.' : 'Chưa thấy danh sách sản phẩm trên trang giỏ hàng.' };
  }
  return { ok: true, items: extractShopeeCartFromDom(document, window) };
}

(window as unknown as { __scrapeShopeeCart: () => Promise<ScrapeResult> }).__scrapeShopeeCart = scrapeCart;
