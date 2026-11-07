# Sổ Canh Giá Shopee (`shopee-tracker`)

Theo dõi giá các phân loại hàng trong giỏ Shopee (`shopee.vn/cart`) mỗi 3 đến 6 giờ từ Chrome đang đăng nhập, lưu lịch sử trên Cloudflare Workers + D1 và báo giá tốt vào nhóm Telegram. Đang chạy ở https://shopee.phamkhanhminhman.com.

Thiết kế giao diện: [DESIGN.md](DESIGN.md). Quy tắc làm việc cho agent: [AGENTS.md](AGENTS.md).

## Cách hoạt động

1. **Tiện ích Chrome (`extension/`):** mỗi 3, 4 hoặc 6 giờ (mặc định 4) tải lại tab giỏ hàng, chờ danh sách nạp xong rồi đọc DOM và gửi bản chụp cho Worker. Máy ngủ qua giờ hẹn thì quét bù khi Chrome mở lại. Gặp trang xác minh CAPTCHA của Shopee, tiện ích dừng quét tự động và hiện dấu "!" trên biểu tượng; xác minh xong thì bấm Quét giỏ hàng ngay.
2. **Worker + D1 (`src/worker/`):** lưu từng phân loại theo `shop_id:item_id:phân loại`, chỉ thêm điểm vào lịch sử khi giá đổi, báo Telegram khi một món đáng chốt.
3. **Web (`src/pages`, `src/client`):** danh sách giá, tab Đáng chốt, đặt giá canh và biểu đồ lịch sử cho từng món, tab Kết nối (Telegram và nhật ký quét).

## Khi nào báo Telegram (`src/lib/deal.ts`)

- Giá về mức giá canh do bạn đặt.
- Đáy mới rẻ hơn lúc bắt đầu canh ít nhất 10.000₫ và 5%.
- Giá Shopee Live rẻ hơn giá giỏ thường ít nhất 20.000₫ và 7%. Live rẻ hơn 1.000₫ không tính.

Mỗi món chỉ báo một lần cho một mức giá. Giá tăng lại từ 5% so với mức đã báo thì lần giảm sau được báo lại.

## Giới hạn

- Chỉ đọc giỏ hàng. Hàng hết hàng hoặc ngưng bán nằm ở mục Inactive của giỏ nên không được theo dõi; hàng quay lại giỏ thì nối tiếp lịch sử cũ.
- Giá là giá hiển thị trong giỏ (giá thường và giá Live), chưa trừ voucher toàn sàn. Lịch sử tính từ lúc bắt đầu theo dõi.
- API không đặt khoá bảo vệ theo lựa chọn của chủ dự án: ai biết địa chỉ đều gọi được.

## Lệnh

```bash
npm install
npm run db:local     # D1 cục bộ
npm run verify       # kiểu dữ liệu, kiểm thử, build
npm run preview      # http://127.0.0.1:8788 (Telegram tắt vì không có secret)
npm run cf:setup     # tạo D1 và áp migration lên Cloudflare
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npm run deploy
```

## Cài tiện ích vào Chrome

1. `npm run ext:build` để tạo `extension/content-scrape.js`.
2. Mở `chrome://extensions`, bật Developer mode, chọn Load unpacked và chọn thư mục `extension`. Sau mỗi lần sửa trong thư mục này, bấm Reload trên thẻ tiện ích.
