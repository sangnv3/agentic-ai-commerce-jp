# 11. Ước tính chi phí Claude API & cách tối ưu

> **Lựa chọn model: ưu tiên chi phí thấp.** Toàn bộ hệ thống dùng **`claude-haiku-5-5`** — model nhẹ và rẻ nhất trong thế hệ Claude hiện tại — cho cả bộ não agent (suy nghĩ, lập kế hoạch, gọi tool) lẫn tác vụ phụ. `claude-sonnet-5-5` chỉ là phương án dự phòng, bật bằng cấu hình nếu evals cho thấy Haiku chưa đủ tốt ở luồng phức tạp.
>
> Bảng giá Anthropic (USD / 1 triệu token), cập nhật 10/2026 — **kiểm tra lại trang giá chính thức trước khi lập ngân sách**. Tỷ giá giả định ¥150/USD. Số token là **ước tính thiết kế**; số thật lấy từ `agent_logs` (token và `cost_usd` từng lời gọi) sau beta.

| Model | Vai trò | Input | Output | Ghi cache (5 phút) | Đọc cache |
|---|---|---|---|---|---|
| **`claude-haiku-5-5`** | **Bộ não agent + tác vụ nhẹ (mặc định)** | **$0.10** | **$0.50** | **$0.125** | **$0.01** |
| `claude-sonnet-5-5` | Dự phòng (chỉ khi cần) | $2.00 | $10.00 | $2.50 | $0.20 |

Haiku 5.5: giá trên áp dụng cho prompt ≤ 100k token; prompt dài hơn tính $0.50 / $2.50. Hệ thống tóm tắt hội thoại khi vượt ~60k token nên luôn nằm trong mức giá thấp.

## 11.1 Mô hình ước tính

**Một lần gọi Haiku trong agent loop:**

| Thành phần | Token | Loại | Chi phí |
|---|---|---|---|
| System prompt (~2,3k) + 14 tool (~5k) | ~7.5k | đọc cache (giống hệt cho mọi khách → luôn “ấm”) | $0.000075 |
| Phần đầu hội thoại đã có (trung bình) | ~6k | đọc cache | $0.000060 |
| Phần mới (tin nhắn khách, customer_context, kết quả tool) | ~1.5k | ghi cache | $0.000188 |
| Output: suy nghĩ (effort `medium`) + câu trả lời + tool call | ~700 | output | $0.000350 |
| **Tổng một lần gọi** | | | **≈ $0.00067** |

**Một đơn hoàn tất**: model nhỏ có thể cần thêm 1 vòng so với Sonnet → giả định **~13 lần gọi** ≈ $0.0088, cộng tác vụ phụ (phân loại ý định, trích xuất sở thích sau đơn và sau đánh giá) ≈ $0.0016 → **≈ $0.0104 / đơn**.
**Phiên không ra đơn** (xem thử, bỏ dở): hệ số ×1.4.

| Kịch bản | Chi phí / đơn (kể cả phiên bỏ dở) | Theo ¥ | % giá trị đơn ¥1.500 |
|---|---|---|---|
| **Haiku 5.5 cho tất cả (mặc định)** | **≈ $0.015** | **≈ ¥2,2** | **~0,15%** |
| Haiku 5.5, effort `low` (nếu evals đạt; output ~450 token/lần gọi) | ≈ $0.012 | ≈ ¥1,8 | ~0,12% |
| *Tham khảo: Haiku nhưng không có prompt caching* | ≈ $0.036 | ≈ ¥5,4 | ~0,4% |
| *Tham khảo: Sonnet 5.5 làm bộ não (thiết kế trước)* | ≈ $0.23 | ≈ ¥34 | ~2,3% |

→ Dùng Haiku cho cả agent rẻ hơn khoảng **15 lần** so với dùng Sonnet; prompt caching vẫn giảm thêm ~60%.

## 11.2 Chi phí theo số đơn mỗi tháng

Cách tính: số đơn × $0.0104 × 1.4. Ví dụ 100.000 đơn × $0.0104 × 1.4 ≈ $1.460.

| Đơn / tháng | **Haiku 5.5 (mặc định)** | Haiku, effort `low` | Tham khảo: Sonnet 5.5 |
|---|---|---|---|
| 10.000 | **≈ $150 (~¥22k)** | ≈ $120 | ≈ $2.300 |
| 50.000 | **≈ $730 (~¥110k)** | ≈ $610 | ≈ $11.500 |
| 100.000 | **≈ $1.460 (~¥220k)** | ≈ $1.220 | ≈ $23.000 |
| 300.000 | **≈ $4.400 (~¥660k)** | ≈ $3.650 | ≈ $69.000 |

Hạn mức mặc định **$0.05 / người / ngày** (≈ 3 đơn đầy đủ) chặn chi phí bất thường từ một tài khoản.

## 11.3 Đánh đổi khi dùng model nhẹ & cách giữ chất lượng

| Rủi ro với model nhỏ | Vì sao vẫn an toàn / cách giảm |
|---|---|
| Lập lại kế hoạch kém hơn ở tình huống phức tạp (nhiều lần đổi ý, đặt nhóm) | System prompt nêu cụ thể cách xử lý từng trở ngại; tool trả mã lỗi + phương án thay thế sẵn (`alternatives`) để model chỉ cần chọn |
| Gọi tool sai tham số | Zod validate phía server, trả lỗi rõ để model tự sửa; chấp nhận tên tool lệch hoa/thường |
| Vi phạm dị ứng / sai giá | **Không phụ thuộc model**: backend ép ràng buộc cứng, tính giá/thuế, và thanh toán chỉ qua nút bấm |
| Từ chối nhầm (refusal) | Haiku không có server-side fallback → thông báo lịch sự + luồng đặt món thường; theo dõi tỷ lệ trong audit |
| Chất lượng chưa đủ sau evals | Đổi `LLM_MAIN_MODEL=claude-sonnet-5-5` (toàn bộ hoặc theo nhóm A/B) — không sửa code; tham số fallback tự bật lại cho Sonnet |

## 11.4 Cách tối ưu chi phí thêm

| # | Cách | Mức tiết kiệm ước tính | Trạng thái |
|---|---|---|---|
| 1 | **Model nhẹ nhất cho mọi tác vụ** (Haiku 5.5) | ~15× so với Sonnet | Đã áp dụng |
| 2 | **Prompt caching**: system prompt + tools tĩnh tuyệt đối; giờ/locale/hồ sơ đi trong tin nhắn user; lịch sử append-only; theo dõi `cache_read_input_tokens` (bằng 0 là có gì đó làm hỏng prefix) | ~60% | Đã có trong code |
| 3 | **Customer context nạp sẵn** ở lượt đầu → bớt 1–2 vòng gọi tool | ~10–15% | Đã có |
| 4 | **Gọn kết quả tool** (5 món, trường cần thiết, mô tả ≤ 200 ký tự) | ~10% | Đã có (cần đo) |
| 5 | **Effort `low`** cho hội thoại đơn giản, nếu evals vẫn đạt (dị ứng 100%, chọn đúng món, số lượt tới màn hình xác nhận) | ~15–20% | Cấu hình `LLM_MAIN_EFFORT` |
| 6 | **Tool call song song** trong một bước | ~5–10% | Đã có |
| 7 | **Batch API (giảm 50%)** cho việc không gấp: tóm tắt review hằng đêm, trích xuất lại sở thích hàng loạt | Nhỏ | Giai đoạn 2 |
| 8 | **Nút “Đặt lại như lần trước”** đi thẳng backend, không gọi LLM | ~100% với đơn lặp lại | Giai đoạn 2 |
| 9 | **Giới hạn**: 12 vòng / 30 tool call / 90 giây mỗi lượt, `max_tokens` 16k, hạn mức theo người dùng/ngày; tóm tắt hội thoại > 60k token (cũng giữ prompt dưới ngưỡng giá 100k của Haiku) | Chặn chi phí đuôi dài | Đã có |
| 10 | **Đo theo “chi phí trên mỗi đơn hoàn tất”** từ `agent_logs`, cảnh báo khi vượt ngưỡng | — | Giai đoạn 1 |
