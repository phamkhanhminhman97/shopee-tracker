# Kế hoạch triển khai & Tối ưu: Sổ Canh Giá Shopee (`shopee-tracker`)

Lập ngày 07/11/2026 sau đợt quét toàn diện (2 subagent Gauss & Epicurus).
Mục tiêu: Canh giá chính xác, phát hiện giảm sâu / chạm giá canh, báo Telegram kịp thời, vận hành bền bỉ không cần người trông.

## Tiến độ ngày 07/11/2026

- **#1 đến #8:** đã sửa trên máy. Kiểm tra đồng bộ mỗi giờ, báo sau 9 giờ và khi hồi phục. Bản chụp thiếu nhiều món cần xác nhận lại; dữ liệu giỏ rỗng chỉ được nhận nếu Shopee có dấu hiệu rõ ràng. Giá Live và giá giỏ có mốc riêng; giá canh vẫn xét giá mua tốt nhất. Migration mới là `0003_tracker_state.sql` và `0004_price_baselines.sql`.
- **#9:** repo, submodule và CI/CD đã hoạt động từ lần triển khai trước. Các bảng bên dưới ghi nhận phát hiện ban đầu.
- **#10 đến #20:** đã sửa và kiểm cục bộ; xem bảng P2 bên dưới.
- **Còn trước khi đưa lên:** sao lưu D1, áp hai migration, deploy qua GitHub Actions, Reload tiện ích 0.3.0 và kiểm một lượt quét thật. Xem [README.md](README.md#đưa-bản-030-lên-production).

---

## 1. Mức P0: Lỗi nghiêm trọng / Đang xảy ra / Nguy cơ mất tín hiệu

| # | Hạng mục | Vị trí | Hiện trạng & Bằng chứng | Đề xuất xử lý | Công sức | Trạng thái |
|---|---|---|---|---|---|---|
| **1** | Báo động khi tiện ích im lặng quá lâu | `extension/background.js:44`, `src/worker/index.ts:76`, `src/client/app.ts:19` | Khi gặp CAPTCHA hoặc trình duyệt tắt dài ngày, tiện ích ngừng quét tự động. Hiện cảnh báo "quá 8 giờ" chỉ hiện trên giao diện web khi người dùng tự mở web, không có báo Telegram. | Thêm Cloudflare Cron Trigger (chạy mỗi giờ). Nếu `MAX(synced_at)` cũ hơn 9–12 giờ, Worker tự gửi 1 tin Telegram cảnh báo tiện ích im lặng; gửi lại 1 tin khi đồng bộ hồi phục. | M | Đã sửa cục bộ |

---

## 2. Mức P1: Cần làm sớm (Ảnh hưởng tính đúng của dữ liệu & trải nghiệm cốt lõi)

| # | Hạng mục | Vị trí | Hiện trạng & Bằng chứng | Đề xuất xử lý | Công sức | Trạng thái |
|---|---|---|---|---|---|---|
| **2** | Sửa tính toán giá gợi ý canh | `src/client/app.ts:331` | Món Baseus đang giá Live 398.000₫ (giá gốc 529.000₫) gợi ý các mức 503k, 476k, 450k (đều cao hơn giá mua hiện tại). Lưu sẽ làm món báo chạm giá canh ngay lập tức. | Tính % giảm từ `Math.min(unitPrice, effectivePrice)`, lọc bỏ mọi mức gợi ý $\ge$ giá mua hiện tại. | S | Đã sửa cục bộ |
| **3** | Sửa hiển thị chu kỳ mặc định trong Popup | `extension/popup.html:39`, `extension/popup.js:16` | Mặc định hệ thống chạy 4 giờ, nhưng popup không có thuộc tính `selected` nên hiển thị nhãn "3 giờ", gây hiểu nhầm và không bắt được sự kiện `change` về 3 giờ. | Gán mặc định: `intervalEl.value = String(data.intervalHours || 4)`. | S | Đã sửa cục bộ |
| **4** | Kiểm soát dữ liệu đầu vào Worker (không cần khóa) | `src/worker/index.ts:53`, `src/worker/store.ts:132`, `src/worker/telegram.ts:26` | API mở cho phép POST chuỗi lạ, `productUrl` giả mạo có thể lọt vào tin nhắn Telegram, giá 1.000₫ có thể phá hỏng mốc đáy vĩnh viễn. | Bắt buộc header riêng từ extension + `content-type: application/json`, validate `shopId`/`itemId` là số, giá 1 – 2.000.000.000₫, tự dựng URL Shopee chuẩn thay vì nhận client URL, rate-limit test Telegram. | M | Đã sửa cục bộ |
| **5** | Chống bản chụp rác làm mất hàng loạt món | `extension/content-scrape.ts:41`, `src/worker/store.ts:237` | Nếu Shopee đổi layout làm parser rớt dòng, hoặc gửi giỏ 3 món khi giỏ thật có 25 món, Worker lập tức đánh dấu 22 món cũ `in_cart = 0`. | Extension hủy gửi nếu parse được $< 80\%$ số dòng DOM; Worker từ chối xóa diện rộng nếu bản chụp mất $> 50\%$ số item quen thuộc mà không có xác nhận lần 2. | M | Đã sửa cục bộ |
| **6** | Độ bền tiện ích Chrome MV3 | `extension/background.js:5,75` | Lỗi mạng chỉ ghi log rồi chờ 4 tiếng sau; `fetch` không có timeout có thể treo biến cờ `running`; báo thức có thể mất khi tắt/bật extension. | Thêm retry sau 10 phút (tối đa 3 lần), thêm `AbortSignal.timeout(30000)`, kiểm tra và tái lập `chrome.alarms` mỗi khi service worker khởi động, tránh reload tab giỏ nếu người dùng đang active thao tác. | S-M | Đã sửa cục bộ |
| **7** | Tách mốc đáy thường và đáy Live | `src/lib/deal.ts:17`, `src/worker/store.ts:165`, Migration 0003 | Hiện tại giá Live được gộp chung vào `min_effective_price`. Khi Live kết thúc, giá thường giảm sâu vẫn có thể bị trượt cảnh báo đáy. | Migration 0003 lưu riêng `min_unit_price` và `min_streaming_price`. Quy tắc đáy áp dụng theo giá giỏ thường; ưu đãi Live có bộ lọc và giãn cách riêng (12h). | M | Đã sửa cục bộ |
| **8** | Lịch sử biểu đồ lấy 200 điểm mới nhất | `src/worker/store.ts:105` | Câu query `ORDER BY id LIMIT 200` lấy 200 điểm cũ nhất từ đầu lịch sử. Với các món Live đổi giá liên tục, biểu đồ sẽ bị "đóng băng" ở quá khứ. | Sửa thành `ORDER BY id DESC LIMIT 200` rồi đảo ngược mảng hiển thị. Thêm test case. | S | Đã sửa cục bộ |
| **9** | Git repository & CI/CD tự động | Thư mục gốc dự án | Dự án chưa có Git, chưa có remote GitHub, chưa nối submodule và chưa có CI kiểm tra tự động trước deploy. | Khởi tạo git, gắn remote `git@github.com:phamkhanhminhman97/shopee-tracker.git`, tạo GitHub Actions `deploy.yml`, thêm vào submodule `minhman-workspace`. | S-M | Đã chạy production |

---

## 3. Mức P2: Độ ổn định, Khả năng dùng & Tài liệu

| # | Hạng mục | Đã làm và kiểm |
|---|---|---|
| **10** | Sao lưu tự động D1 | `db:backup` ghi SQL riêng tư vào `backups/`; `db:backup:schedule` cài lịch macOS, chỉ xuất nếu bản gần nhất đủ 7 ngày. Đã kiểm CLI với Wrangler giả, dọn file xuất dở và kiểm plist. Chưa bật lịch với D1 thật. |
| **11** | Kiểm thử và kiểm kiểu | `tests/fixtures/cart.html` dùng dữ liệu mẫu, nạp theo hai đợt. Worker được kiểm với D1 và Telegram giả. `verify` kiểm kiểu script/test; CI chạy thêm kiểm Chrome. |
| **12** | Chống báo trùng | D1 cấp quyền xử lý đồng bộ bằng lệnh SQL có điều kiện trước khi gửi. Test giữ lượt gửi Telegram đầu tiên đang chạy và kiểm lượt chồng bị trả 409. |
| **13** | Đọc tiền và chuẩn hóa tiếng Việt | Hiểu `350k`, `1.5tr`, `3,5 triệu`; từ chối giá thập phân mơ hồ và chuẩn hóa khóa phân loại bằng NFC. Có test hồi quy. |
| **14** | Lỗi API và log Worker | JSON hoặc mã phân loại lỗi trả 400. Lỗi D1 trả 500 với thông báo chung, log có đường dẫn mẫu và kiểu lỗi. Sampling là 1. |
| **15** | Thanh đầu trang và focus | Thêm khoảng chừa khi cuộn đến focus; bỏ ghim ở màn hình thấp. Kiểm Shift+Tab bằng Chrome. |
| **16** | Biểu đồ ở màn hình hẹp | Chiều rộng SVG theo khung thật, min/max ở dòng riêng để xuống hàng được. Kiểm ở 320 px bằng Chrome. |
| **17** | Thao tác và nhãn | Nút đổi chế độ dùng `aria-pressed`; nút giá canh có tên món và phân loại; kéo chọn chữ rồi thả ngoài hộp không làm đóng hộp; ô giá canh có ví dụ và hướng dẫn riêng. |
| **18** | Làm mới và ảnh lỗi | Tab đang hiện tải lại sau 5 phút, giữ focus và vị trí cuộn bảng. Ảnh lỗi có chỗ giữ kích thước. Kiểm cả hai bằng Chrome. |
| **19** | Noindex, cache, icon | Đã kiểm header trên Worker cục bộ: trang và API noindex, tệp băm cache immutable, API no-store. Đã kiểm PNG 192/512, 512 maskable và Apple touch 180 trên bản dựng. |
| **20** | Tài liệu | README workspace đã có submodule; bàn giao ghi trình tự phát hành. README dự án có cách sao lưu và kiểm tra. DESIGN ghi màu badge và nguồn icon. |
