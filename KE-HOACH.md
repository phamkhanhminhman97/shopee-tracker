# Kế hoạch triển khai & Tối ưu: Sổ Canh Giá Shopee (`shopee-tracker`)

Lập ngày 07/11/2026 sau đợt quét toàn diện (2 subagent Gauss & Epicurus).
Mục tiêu: Canh giá chính xác, phát hiện giảm sâu / chạm giá canh, báo Telegram kịp thời, vận hành bền bỉ không cần người trông.

---

## 1. Mức P0: Lỗi nghiêm trọng / Đang xảy ra / Nguy cơ mất tín hiệu

| # | Hạng mục | Vị trí | Hiện trạng & Bằng chứng | Đề xuất xử lý | Công sức | Trạng thái |
|---|---|---|---|---|---|---|
| **1** | Báo động khi tiện ích im lặng quá lâu | `extension/background.js:44`, `src/worker/index.ts:76`, `src/client/app.ts:19` | Khi gặp CAPTCHA hoặc trình duyệt tắt dài ngày, tiện ích ngừng quét tự động. Hiện cảnh báo "quá 8 giờ" chỉ hiện trên giao diện web khi người dùng tự mở web, không có báo Telegram. | Thêm Cloudflare Cron Trigger (chạy mỗi giờ). Nếu `MAX(synced_at)` cũ hơn 9–12 giờ, Worker tự gửi 1 tin Telegram cảnh báo tiện ích im lặng; gửi lại 1 tin khi đồng bộ hồi phục. | M | Chờ làm |

---

## 2. Mức P1: Cần làm sớm (Ảnh hưởng tính đúng của dữ liệu & trải nghiệm cốt lõi)

| # | Hạng mục | Vị trí | Hiện trạng & Bằng chứng | Đề xuất xử lý | Công sức | Trạng thái |
|---|---|---|---|---|---|---|
| **2** | Sửa tính toán giá gợi ý canh | `src/client/app.ts:331` | Món Baseus đang giá Live 398.000₫ (giá gốc 529.000₫) gợi ý các mức 503k, 476k, 450k (đều cao hơn giá mua hiện tại). Lưu sẽ làm món báo chạm giá canh ngay lập tức. | Tính % giảm từ `Math.min(unitPrice, effectivePrice)`, lọc bỏ mọi mức gợi ý $\ge$ giá mua hiện tại. | S | Chờ làm |
| **3** | Sửa hiển thị chu kỳ mặc định trong Popup | `extension/popup.html:39`, `extension/popup.js:16` | Mặc định hệ thống chạy 4 giờ, nhưng popup không có thuộc tính `selected` nên hiển thị nhãn "3 giờ", gây hiểu nhầm và không bắt được sự kiện `change` về 3 giờ. | Gán mặc định: `intervalEl.value = String(data.intervalHours || 4)`. | S | Chờ làm |
| **4** | Kiểm soát dữ liệu đầu vào Worker (không cần khóa) | `src/worker/index.ts:53`, `src/worker/store.ts:132`, `src/worker/telegram.ts:26` | API mở cho phép POST chuỗi lạ, `productUrl` giả mạo có thể lọt vào tin nhắn Telegram, giá 1.000₫ có thể phá hỏng mốc đáy vĩnh viễn. | Bắt buộc header riêng từ extension + `content-type: application/json`, validate `shopId`/`itemId` là số, giá 1 – 2.000.000.000₫, tự dựng URL Shopee chuẩn thay vì nhận client URL, rate-limit test Telegram. | M | Chờ làm |
| **5** | Chống bản chụp rác làm mất hàng loạt món | `extension/content-scrape.ts:41`, `src/worker/store.ts:237` | Nếu Shopee đổi layout làm parser rớt dòng, hoặc gửi giỏ 3 món khi giỏ thật có 25 món, Worker lập tức đánh dấu 22 món cũ `in_cart = 0`. | Extension hủy gửi nếu parse được $< 80\%$ số dòng DOM; Worker từ chối xóa diện rộng nếu bản chụp mất $> 50\%$ số item quen thuộc mà không có xác nhận lần 2. | M | Chờ làm |
| **6** | Độ bền tiện ích Chrome MV3 | `extension/background.js:5,75` | Lỗi mạng chỉ ghi log rồi chờ 4 tiếng sau; `fetch` không có timeout có thể treo biến cờ `running`; báo thức có thể mất khi tắt/bật extension. | Thêm retry sau 10 phút (tối đa 3 lần), thêm `AbortSignal.timeout(30000)`, kiểm tra và tái lập `chrome.alarms` mỗi khi service worker khởi động, tránh reload tab giỏ nếu người dùng đang active thao tác. | S-M | Chờ làm |
| **7** | Tách mốc đáy thường và đáy Live | `src/lib/deal.ts:17`, `src/worker/store.ts:165`, Migration 0003 | Hiện tại giá Live được gộp chung vào `min_effective_price`. Khi Live kết thúc, giá thường giảm sâu vẫn có thể bị trượt cảnh báo đáy. | Migration 0003 lưu riêng `min_unit_price` và `min_streaming_price`. Quy tắc đáy áp dụng theo giá giỏ thường; ưu đãi Live có bộ lọc và giãn cách riêng (12h). | M | Chờ làm |
| **8** | Lịch sử biểu đồ lấy 200 điểm mới nhất | `src/worker/store.ts:105` | Câu query `ORDER BY id LIMIT 200` lấy 200 điểm cũ nhất từ đầu lịch sử. Với các món Live đổi giá liên tục, biểu đồ sẽ bị "đóng băng" ở quá khứ. | Sửa thành `ORDER BY id DESC LIMIT 200` rồi đảo ngược mảng hiển thị. Thêm test case. | S | Chờ làm |
| **9** | Git repository & CI/CD tự động | Thư mục gốc dự án | Dự án chưa có Git, chưa có remote GitHub, chưa nối submodule và chưa có CI kiểm tra tự động trước deploy. | Khởi tạo git, gắn remote `git@github.com:phamkhanhminhman97/shopee-tracker.git`, tạo GitHub Actions `deploy.yml`, thêm vào submodule `minhman-workspace`. | S-M | **Đang làm** |

---

## 3. Mức P2: Độ ổn định, Khả năng dùng & Tài liệu

| # | Hạng mục | Vị trí | Chi tiết | Công sức |
|---|---|---|---|---|
| **10** | Sao lưu tự động D1 | `package.json`, script backup | Thêm lệnh `npm run db:backup` xuất SQL định kỳ vào `backups/` (gitignore) trước khi chạy các migration tiếp theo. | S |
| **11** | Bổ sung test coverage & typecheck | `tests/`, tsconfig | Thêm fixture HTML giỏ hàng ẩn danh để test trọn vẹn `cart-parser.ts`; bổ sung test cho Worker branches; thêm typecheck cho scripts/tests. | M |
| **12** | Chống race-condition báo trùng | `src/worker/store.ts:138` | Giành cờ cảnh báo bằng câu lệnh SQL UPDATE có điều kiện trước khi bắn Telegram để tránh gửi trùng nếu 2 phiên sync chạy sát nhau. | S-M |
| **13** | Chuẩn hóa parser số tiền & tiếng Việt | `src/lib/model.ts:86`, `cart-parser.ts` | Hỗ trợ parse "350k", "1.5tr", chặn hiểu sai số thập phân; chuẩn hóa Unicode NFC cho cartKey. | S |
| **14** | Worker error handling & sampling | `src/worker/index.ts:114` | Log `console.error` rõ ràng khi có exception, trả HTTP 400 thay vì 500 khi JSON lỗi, tăng `head_sampling_rate`. | S |
| **15** | Tối ưu sticky header & scroll padding | `src/styles/site.css:52` | Thêm `html { scroll-padding-top: 112px; }` tránh che focus khi Shift+Tab; bỏ sticky trên màn hình chiều dọc thấp ($< 600$px). | S |
| **16** | Tinh chỉnh biểu đồ responsive & trục tọa độ | `src/client/app.ts:273`, `site.css` | Tính toán width SVG động theo clientWidth trên mobile, hiển thị min/max rõ ràng trên nhãn. | S-M |
| **17** | Hoàn thiện vi mô UX/A11y | `index.astro`, `app.ts` | Đổi `aria-current` sang `aria-pressed` cho tab filter; thêm aria-label phân biệt 25 nút "Đặt giá canh"; chống đóng dialog nhầm khi thả chuột từ input; fix placeholder mobile. | S |
| **18** | Tự làm mới sau 5 phút & xử lý ảnh lỗi | `src/client/app.ts` | Polling nhẹ làm mới dữ liệu sau mỗi 5 phút nếu tab đang mở; fallback ảnh rỗng nếu CDN Shopee lỗi. | S |
| **19** | Bảo vệ SEO & Caching assets | `public/_headers`, `index.astro` | Thêm `noindex, nofollow` bảo vệ riêng tư giỏ hàng; cấu hình cache vĩnh viễn `/_astro/*` có hash; thêm PNG icons cho PWA nếu cần. | S |
| **20** | Đồng bộ tài liệu workspace & Design | `README.md`, `ai/BAN-GIAO-AI.md` | Cập nhật bản đồ repo minhman-workspace; ghi nhận ngoại lệ màu badge extension trong DESIGN.md. | S |
