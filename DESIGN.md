# Thiết kế giao diện: Sổ Canh Giá Shopee

Design Read: sổ giá cá nhân cho một người mua trong gia đình, dùng chung ngôn ngữ thiết kế với `websites/memories` (xám trung tính, một màu nhấn hổ phách, Geist, Phosphor), theo hệ điều hành sáng hoặc tối. Dial ENERGY 2 / RHYTHM 2 / MOTION 1.

## Nguồn cảm hứng

- `websites/memories` (`docs/DESIGN.md`, `web/xem_thu_vien.css`): bảng màu, phông, thang khoảng cách, bo góc, cách đặt thanh trên cùng màu với thanh bên, danh sách nền surface viền `--line`, trạng thái rỗng có biểu tượng.
- `websites/moments` (qua memories): chuyển động ngắn, chỉ animate transform và opacity, cách hiện từ scale .97.

Bản cũ (nền giấy ấm, đỏ gạch, xanh rêu, Manrope, nút chuyển chủ đề) đã bỏ vì trông như mẫu chung của AI.

## Quyết định

| Hạng mục | Chọn | Lý do |
|---|---|---|
| Màu | Nền `#181818`, mặt `#1F1F1F`, nâng `#313131`; sáng `#F5F5F5` / `#FFFFFF` / `#E3E3E3`; một màu nhấn hổ phách `#E2A656` (sáng: `#7A4212`) | Khớp memories; màu nhấn chỉ dành cho món đáng chốt, số đếm và nút chính |
| Chủ đề | Theo `prefers-color-scheme`, mặc định tối, không có nút chuyển | Khớp memories; bớt một nút, một đoạn script đầu trang và một khoá localStorage |
| Chữ | Geist 400/500/600 tự host (có tiếng Việt), số tabular | Cột giá thẳng hàng; không tải phông từ bên thứ ba (CSP `font-src 'self'`) |
| Thang chữ | 12/16, 14/20, 20/28, 24/32 | Cùng thang với memories |
| Khoảng cách, bo góc | Biến `--s-*` (2 đến 96 px), `--r-*` (4, 6, 8, 12) | Không có giá trị lẻ |
| Bố cục | Thanh trên cùng màu rail (tên, tab, tìm, sắp xếp, dòng đồng bộ), bên dưới là một danh sách | Mọi thứ cho quyết định mua nằm trong một màn |
| Dòng sản phẩm | Ảnh 56 px, shop, tên, chip, giá 20 px, "Đặt giá canh" và nút mở Shopee dạng biểu tượng | Giá là thứ to nhất trên dòng |
| Điểm nhấn | Chip viền hổ phách kèm biểu tượng và chữ nêu lý do, giá hổ phách | Món đáng chốt có chữ giải thích, không chỉ dựa vào màu |
| Biểu tượng | Phosphor regular nhúng SVG: tìm, đóng, mở ngoài, mũi tên chọn, chuông tắt, cảnh báo, xu hướng giảm, gắn kết | Cùng kho với memories, giấy phép ở `PHOSPHOR_LICENSE.txt` |
| Ảnh sản phẩm | Bản `_tn` của Shopee (320 px) | Đã kiểm 25/25 ảnh trong giỏ trả 200; tổng 639 KB thay vì 11,2 MB |
| Trạng thái | Khung xương khi tải, thông báo lỗi có nút Tải lại, sổ rỗng có nút tới hướng dẫn, cảnh báo quá 8 giờ chưa đồng bộ | Không có vòng quay |
| Chuyển động | Nút lún `scale(.98)`, hộp thoại hiện 180 ms, khung xương nhấp nháy opacity; tắt khi bật giảm chuyển động | Phản hồi thao tác, không có gì chạy nền |
| Cấm | Gradient nền, kính mờ, bóng đổ trang trí (theo memories), vạch màu ở mép trái dòng | Các dấu hiệu quen thuộc của giao diện AI chung chung |

## Độ tương phản (đo bằng `contrast-check.py`)

| Cặp màu | Tối | Sáng |
|---|---:|---:|
| Chữ / nền | 15,17 | 16,44 |
| Chữ / mặt | 14,08 | 17,93 |
| Chữ phụ / mặt | 5,93 | 6,69 |
| Chữ phụ / nâng (số đếm ở tab đang chọn) | 4,68 | 5,21 |
| Nhấn / mặt | 7,71 | 8,03 |
| Nhấn / nâng | 6,08 | 6,26 |
| Chữ nút chính / nền nút | 8,78 | 8,03 |
| Viền điều khiển / nền | 3,33 | 3,38 |
| Viền điều khiển / mặt | 3,09 | 3,69 |

Sáng, viền điều khiển trên thanh trên cùng (`#EBEBEB`): 3,10. Chữ cần từ 4,5 trở lên, viền điều khiển cần từ 3,0 trở lên.

## Bố cục theo độ rộng

1. **Từ 900 px:** mỗi dòng nằm trên một hàng: ảnh, tên và chip, giá, hai nút.
2. **640 đến 899 px:** giá nằm bên phải tên, các nút xuống hàng dưới tên.
3. **Dưới 640 px:** thanh trên cùng không còn dính đầu trang; ô tìm và ô sắp xếp chung một hàng; mỗi dòng gồm ảnh và tên, giá một hàng riêng, nút "Đặt giá canh" giãn hết chiều ngang cạnh nút mở Shopee.

## Đã bỏ

Khi rà soát 07/11:

- Khối "Đáng chốt lúc này" ở đầu trang: lặp lại đúng các dòng đầu của danh sách đã xếp theo giá tốt.
- Cột lọc bên trái, ngăn lọc trượt trên điện thoại, lọc theo shop và theo tình trạng: 25 món chỉ cần ô tìm và ô sắp xếp.
- Thanh biên độ giá và dòng "Kiểm lúc": lặp lại giá đang hiển thị khi lịch sử còn ít; thay bằng một dòng "Thấp nhất đã ghi nhận" khi giá đã tăng lại.
- Tab "Đã ẩn", nút ẩn và xoá món: món rời giỏ tự biến khỏi sổ nhưng giữ lịch sử.
- Đoạn giới thiệu và tiêu đề trùng tên thương hiệu, nút "Làm mới" (thay bằng tự tải lại khi quay lại tab), nút "Mở Giỏ Shopee", liên kết Shopee trong hộp thoại.
- Biến thể ARIA tab không có tabpanel, URL trạng thái, dữ liệu cố định "Chu kỳ 3 đến 6 giờ".
- Thông báo tiếng Anh của Shopee ("Up to 60k off voucher available") được dịch sang tiếng Việt khi hiển thị.

Khi thiết kế lại theo memories:

- Nút chuyển Sáng/Tối và khoá localStorage: giao diện theo hệ điều hành.
- Chân trang "Giá được ghi nhận từ lúc bắt đầu theo dõi": hộp chi tiết đã ghi ngày bắt đầu theo dõi của từng món.
- Phông Manrope (gói npm) và vòng quay khi tải.
- Màu xanh rêu và đỏ gạch: lỗi và cảnh báo dùng chung màu nhấn kèm biểu tượng hoặc chữ.
