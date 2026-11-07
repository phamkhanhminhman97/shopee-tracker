# AGENTS.md: shopee-tracker

Quy tắc làm việc chung nằm ở [../../AGENTS.md](../../AGENTS.md). Khi mâu thuẫn, file gốc thắng.

## Quy tắc riêng của thư mục này

- Giao diện theo [DESIGN.md](DESIGN.md) và bộ lọc `antislop` (không dùng em dash, tương phản WCAG AA ở cả hai chế độ, vùng chạm tối thiểu 44 x 44 px). Đo tương phản bằng `contrast-check.py` trước khi đổi màu.
- Không ghi `TELEGRAM_BOT_TOKEN` hay `TELEGRAM_CHAT_ID` vào file được git theo dõi hoặc nhật ký chung. Trên máy đặt trong `.dev.vars` (đã gitignore); trên Cloudflare đặt bằng `wrangler secret put`.
- Không gọi `shopee.vn/api/...` từ ngoài trình duyệt. Shopee trả 403 (mã 90309999) và có thể bắt CAPTCHA trên chính tài khoản và mạng của người dùng. Dữ liệu chỉ lấy bằng cách đọc DOM trang giỏ hàng trong Chrome đang đăng nhập.
- Kiểm thử yêu cầu ghi chỉ dùng Worker cục bộ hoặc máy chủ giả. API production ghi trực tiếp vào D1 thật và có thể gửi Telegram.
- Bộ đọc giỏ hàng nằm ở `src/lib/cart-parser.ts` và được đóng gói thành `extension/content-scrape.js` bằng `npm run ext:build` (đã gitignore, không sửa tay). Sửa trong `extension/` xong phải bấm Reload ở `chrome://extensions` thì Chrome mới nhận.
- Đổi cấu trúc D1 bằng migration mới trong `migrations/`, không sửa migration đã áp. Sao lưu trước khi áp lên bản thật: `wrangler d1 export shopee-tracker --remote --output <tệp>`.
- Lệnh kiểm tra bắt buộc trước khi báo xong hoặc deploy: `npm run verify` (kiểu dữ liệu, kiểm thử, build).
