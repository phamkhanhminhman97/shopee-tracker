# Sổ Canh Giá Shopee (`shopee-tracker`)

Theo dõi giá các phân loại hàng trong giỏ Shopee (`shopee.vn/cart`) mỗi 3 đến 6 giờ từ Chrome đang đăng nhập, lưu lịch sử trên Cloudflare Workers + D1 và báo giá tốt vào nhóm Telegram. Đang chạy ở https://shopee.phamkhanhminhman.com.

Thiết kế: [DESIGN.md](DESIGN.md). Tiến độ rà soát: [KE-HOACH.md](KE-HOACH.md). Quy tắc làm việc: [AGENTS.md](AGENTS.md).

## Cách hoạt động

1. **Tiện ích Chrome (`extension/`):** mỗi 3, 4 hoặc 6 giờ (mặc định 4) mở tab giỏ hàng riêng ở nền rồi đọc danh sách. Nếu lỗi mạng, thử lại sau 10 phút, tối đa 3 lần. Gặp CAPTCHA, tiện ích dừng quét tự động và hiện dấu "!"; xác minh xong thì bấm **Quét giỏ hàng ngay**.
2. **Worker + D1 (`src/worker/`):** giữ lịch sử riêng theo phân loại. Nếu giỏ đã lưu có từ 5 món mà bản mới thiếu hơn nửa, hoặc giỏ từ có hàng chuyển sang rỗng, Worker chờ bản chụp cùng danh sách lần nữa trong một giờ. Worker kiểm tra mỗi giờ và gửi Telegram khi quá 9 giờ chưa nhận lượt quét thành công, rồi báo một lần khi đồng bộ lại.
3. **Web (`src/pages`, `src/client`):** danh sách giá, tab Đáng chốt, đặt giá canh và biểu đồ lịch sử cho từng món, tab Kết nối (Telegram và nhật ký quét).

Ở **Giỏ hàng**, bấm **Đổi vị trí**, kéo món hoặc dùng mũi tên lên/xuống rồi bấm **Xong**. Chọn **Tự sắp xếp** để xem lại thứ tự đã lưu trên trình duyệt. Thứ tự này chỉ áp dụng trong sổ canh giá.

## Khi nào báo Telegram (`src/lib/deal.ts`)

- Giá về mức giá canh do bạn đặt.
- Đáy giá giỏ thường rẻ hơn lúc bắt đầu canh ít nhất 10.000₫ và 5%. Giá Live có mốc riêng.
- Giá Shopee Live rẻ hơn giá giỏ thường ít nhất 20.000₫ và 7%. Live rẻ hơn 1.000₫ không tính.

Giá canh có thể báo lại khi giá đã tăng từ 5% rồi giảm xuống. Đáy giá giỏ chỉ báo lại khi rẻ hơn đáy đã báo. Báo giá Live của mỗi món cách nhau ít nhất 12 giờ.

Mỗi món có thể có nhiều lý do đủ điều kiện trong cùng một tin. Danh sách dài được chia thành nhiều tin; chỉ món đã gửi thành công được đánh dấu đã báo. Tin lỗi được thử lại theo lịch 5 phút trong 30 phút kể từ lần ghi nhận; Worker bỏ giá đã đổi, món rời giỏ hoặc đã tắt báo.

## Giới hạn

- Chỉ đọc giỏ hàng. Hàng hết hàng hoặc ngưng bán nằm ở mục Inactive của giỏ nên không được theo dõi; hàng quay lại giỏ thì nối tiếp lịch sử cũ.
- Giá là giá hiển thị trong giỏ (giá thường và giá Live), chưa trừ voucher toàn sàn. Lịch sử tính từ lúc bắt đầu theo dõi.
- API không xác thực theo lựa chọn của chủ dự án. Yêu cầu ghi phải có header `X-Shopee-Tracker: 1`; header này chặn yêu cầu đơn giản từ trang khác, nhưng ai biết địa chỉ vẫn có thể gọi API trực tiếp.

## Lệnh

```bash
npm ci
npm run db:local     # D1 cục bộ
npm run verify       # kiểu dữ liệu, kiểm thử, build
npm run check:browser # Chrome và openssl; giao diện và tiện ích dùng máy chủ giả
npm run preview      # http://127.0.0.1:8788 (Telegram tắt vì không có secret)
```

## Cài tiện ích vào Chrome

1. `npm run ext:build` để tạo `extension/content-scrape.js`.
2. Mở `chrome://extensions`, bật Developer mode, chọn Load unpacked và chọn thư mục `extension`. Sau mỗi lần sửa trong thư mục này, bấm Reload trên thẻ tiện ích.

## Sao lưu D1

- `npm run db:backup` xuất SQL từ D1 thật vào thư mục `backups/` trên máy. File sao lưu chỉ chủ tài khoản đọc được và nằm ngoài Git.
- Trên macOS, sau khi kiểm lệnh sao lưu tay thành công, chạy `npm run db:backup:schedule` để bật lịch cho tài khoản đang đăng nhập. Máy kiểm tra lúc đăng nhập và lúc 03:30 theo giờ máy mỗi ngày; chỉ xuất bản mới khi chưa có bản sao hoặc bản gần nhất đã đủ 7 ngày. Xem kết quả tại `backups/backup.log`.
- Để xem cấu hình mà chưa bật lịch: `npm run db:backup:schedule -- --print`. Để tắt lịch đang chạy và bỏ tự khởi động, dùng `launchctl bootout "gui/$(id -u)/com.phamkhanhminhman.shopee-tracker.backup"` rồi chuyển file `com.phamkhanhminhman.shopee-tracker.backup.plist` ra khỏi `~/Library/LaunchAgents/`.

## Đưa thay đổi lên production

1. Từ thư mục dự án, chạy `npm run db:backup` để xuất bản sao D1 vào `backups/`. Chỉ chạy bước tiếp theo nếu xuất thành công.
2. Áp migration trước khi đưa mã mới lên `main`: `npx wrangler d1 migrations apply shopee-tracker --remote`. Luồng gửi lại Telegram cần `0005_alert_outbox.sql`.
3. Khi đẩy mã lên `main`, GitHub Actions chạy kiểm tra và deploy Worker. Kiểm tra lần chạy thành công.
4. Nếu Chrome đang dùng tiện ích trước 0.3.0, chạy `npm run ext:build` trên máy dùng Shopee, Reload tiện ích rồi quét một lượt.
