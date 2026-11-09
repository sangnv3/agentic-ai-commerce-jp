# Agentic AI Commerce — Đặt món ăn bằng AI Agent dùng Claude API (thị trường Nhật Bản)

Thiết kế nâng cấp hệ thống đặt món hiện tại (React + Node.js + Algolia + Entra ID + REST/GraphQL)
thành mô hình **Agentic AI Commerce**. **Claude API là bộ não**: suy nghĩ, lập kế hoạch, quyết định gọi tool.
**Backend Node.js là đôi tay**: kiểm tra quyền, validate, thực thi thật. Agent làm thay khách gần như toàn bộ
quy trình đặt món, **chỉ trừ bước xác nhận thanh toán — bước này bắt buộc do con người bấm nút trên UI.**

## Cấu trúc dự án

```
backend/     Node.js + TypeScript — API REST + SSE chat, agent (Claude Haiku 5.5), module bán hàng trên PostgreSQL,
             Redis (phiên chat, idempotency, hạn mức), migrations, dữ liệu mẫu
frontend/    ReactJS (Vite) — đăng nhập (demo / Microsoft Entra ID), khung chat, thẻ món, giỏ mini,
             màn hình xác nhận thanh toán, lịch sử đơn & hóa đơn
Dockerfile   build cả hai thành một image (backend phục vụ luôn frontend) — dùng cho Railway
railway.json cấu hình deploy Railway (pre-deploy: migrate + seed, healthcheck /healthz)
.github/     CI: typecheck, test, build, migration, docker build
docs/        thiết kế (mục 1–12), hướng dẫn chạy local và deploy
```

**Bắt đầu nhanh:** chạy ở local → [docs/LOCAL-DEV.md](docs/LOCAL-DEV.md) · deploy Railway → [docs/DEPLOY-RAILWAY.md](docs/DEPLOY-RAILWAY.md)

## Mục lục

| # | Nội dung | File |
|---|---|---|
| 0 | Giả định | (bên dưới) |
| 1 | Tổng quan giải pháp & giá trị | (bên dưới) |
| 2–4 | Kiến trúc tổng thể · Vòng lặp Agent (Claude ↔ backend) · Sequence diagram end-to-end | [docs/02-architecture.md](docs/02-architecture.md) |
| 5 | Kịch bản hội thoại mẫu (JA + VI), ghi chú tool Claude gọi ở mỗi bước, các nhánh lỗi | [docs/05-conversation-scripts.md](docs/05-conversation-scripts.md) |
| 6 | Định nghĩa tool (JSON Schema), system prompt, confirmation token, ranker, Preference Memory, quản lý ngữ cảnh | [docs/06-agent-tools-and-prompt.md](docs/06-agent-tools-and-prompt.md) |
| 7 | Data model | [docs/07-data-model.md](docs/07-data-model.md) |
| 8 | API: REST + GraphQL + SSE | [docs/08-api.md](docs/08-api.md) |
| 9 | Wireframe UI | [docs/09-ui-wireframes.md](docs/09-ui-wireframes.md) |
| 10 | Code (giải thích) | [docs/10-code-skeleton.md](docs/10-code-skeleton.md) → [backend/](backend/), [frontend/](frontend/) |
| 11 | Ước tính chi phí Claude API & tối ưu | [docs/11-cost-estimate.md](docs/11-cost-estimate.md) |
| 12 | Rủi ro, bảo mật, lộ trình | [docs/12-risks-roadmap.md](docs/12-risks-roadmap.md) |
| — | **Chạy & test ở local** | [docs/LOCAL-DEV.md](docs/LOCAL-DEV.md) |
| — | **Deploy lên Railway qua GitHub** | [docs/DEPLOY-RAILWAY.md](docs/DEPLOY-RAILWAY.md) |

---

## 0. Giả định

| # | Giả định | Ảnh hưởng nếu sai |
|---|---|---|
| A1 | Hạ tầng chạy trên **Azure** (vì đã dùng Entra ID): AKS/App Service, Azure Database for PostgreSQL, Azure Cache for Redis, Blob Storage, Key Vault. | Đổi sang AWS/GCP chỉ đổi managed service tương đương. |
| A2 | DB nghiệp vụ hiện tại là **PostgreSQL**. Preference store dùng PostgreSQL + **pgvector** (không thêm vector DB riêng ở MVP). | Nếu là MySQL/Mongo: giữ schema logic, đổi DDL. |
| A3 | **Một backend Node.js duy nhất** gồm: API cho frontend, agent (Claude), và các module bán hàng (menu, giỏ, đơn, thanh toán, hóa đơn) trên PostgreSQL. Trong tài liệu thiết kế, phần bán hàng được gọi là "Commerce API" — trong repo này đó là các module `backend/src/commerce/*`, agent gọi trực tiếp (không qua HTTP). | Nếu sau này tách thành service riêng, chỉ cần bọc các module đó bằng REST/GraphQL. |
| A4 | Algolia index `menu_items_ja` / `menu_items_en` đã tồn tại; **bổ sung thuộc tính**: `allergens`, `dietary_tags`, `taste_tags`, `price_incl_tax`, `available_slots`, `delivery_area_codes`, `restaurant_id`, `is_sold_out`. | — |
| A5 | Payment gateway: một PSP Nhật hỗ trợ thẻ + PayPay + ví (ví dụ GMO Payment Gateway, Stripe JP, PAY.JP) qua lớp **PaymentAdapter**. Trả sau cho doanh nghiệp (掛け払い) qua dịch vụ BNPL B2B (ví dụ NP掛け払い, Paid) qua cùng adapter. | Chỉ cần viết adapter mới. |
| A6 | Thẻ lưu dưới dạng **token của PSP** (PCI DSS: hệ thống không lưu số thẻ). Không có dữ liệu thẻ nào đi vào prompt của Claude — chỉ nhãn kiểu "VISA ****4242". | — |
| A7 | Email: **Azure Communication Services Email**; SendGrid là phương án thay thế qua `EmailAdapter`. | — |
| A8 | **Claude API** gọi trực tiếp tới Anthropic qua `@anthropic-ai/sdk`. **Ưu tiên chi phí thấp: dùng `claude-haiku-5-5` (model nhẹ, rẻ nhất) cho cả bộ não agent lẫn tác vụ nhẹ** (phân loại ý định, trích xuất sở thích, tóm tắt). `claude-sonnet-5-5` là phương án dự phòng nếu evals cho thấy cần. Model, effort, timeout và hạn mức nằm trong cấu hình của lớp `LLMProvider`. | Đổi model = đổi biến môi trường `LLM_MAIN_MODEL`, không sửa code. |
| A9 | API key Claude chỉ nằm ở backend: biến môi trường `ANTHROPIC_API_KEY` (local: `.env` đã git-ignore; production: Azure Key Vault reference, đọc qua Managed Identity). Frontend không bao giờ giữ key. | — |
| A10 | Giá menu lưu và hiển thị **đã gồm thuế** (総額表示). Thuế trên hóa đơn tính ngược theo từng mức thuế suất, **làm tròn 1 lần cho mỗi mức thuế trên mỗi hóa đơn** (quy tắc 適格請求書). | — |
| A11 | Thuế suất: món ăn giao tận nơi / mang đi **8% (軽減税率)**; **phí giao hàng 10%**; đồ uống có cồn, hàng không phải thực phẩm **10%**. Hộp đựng đi kèm món ăn tính chung 8%. | `tax_category` ở từng item quyết định. |
| A12 | Doanh nghiệp vận hành là 適格請求書発行事業者 (số `T` + 13 chữ số). Nếu là marketplace nhiều nhà hàng: hóa đơn do **nền tảng** phát hành theo 媒介者交付特例; mỗi nhà hàng cũng là đơn vị đăng ký. | Nếu nhà hàng tự phát hành, tách hóa đơn theo nhà hàng. |
| A13 | Khung giờ giao 30 phút; thời gian chuẩn bị tối thiểu mặc định 45 phút; giờ đóng đơn giao trưa 10:30 cùng ngày (cấu hình theo nhà hàng). | Cấu hình được. |
| A14 | Một đơn hàng = một nhà hàng. Agent cảnh báo nếu khách muốn trộn món từ nhiều nhà hàng. | — |
| A15 | Ngôn ngữ mặc định `ja-JP`; `en` lấy từ cài đặt người dùng hoặc ngôn ngữ khách đang gõ. | — |
| A16 | Quy mô tham chiếu cho chi phí: 10.000–300.000 đơn/tháng; đỉnh 11:00–12:00. Tỷ giá ước tính ¥150/USD. | Ảnh hưởng con số chi phí, không ảnh hưởng thiết kế. |

---

## 1. Tổng quan giải pháp & giá trị so với hệ thống cũ

**Giải pháp**: thêm một **Agent Service** (Node.js) giữa UI và Commerce API.

- **Claude (`claude-haiku-5-5`, model nhẹ và rẻ nhất) — bộ não**: đọc tin nhắn, ngữ cảnh và hồ sơ sở thích → tự xác định còn thiếu gì, cần làm bước nào, theo thứ tự nào → quyết định gọi tool với tham số (ví dụ dịch "nhẹ, ít dầu, dưới ¥1.500" thành `search_menu` query + filters) → đọc kết quả, **tự lập lại kế hoạch** khi gặp trở ngại (hết món → tìm món tương đương; khung giờ đầy → đề xuất khung gần nhất; vượt ngân sách → đổi tổ hợp) → trả lời tự nhiên, stream về khung chat.
- **Backend Node.js — đôi tay**: kiểm tra quyền (Entra ID), validate tham số (Zod), chạy function thật (Algolia, DB, PSP, email), **tự ép các ràng buộc cứng** (dị ứng, giá, thuế, tồn kho) — không phụ thuộc vào việc Claude có tuân thủ hay không.
- **Cũng `claude-haiku-5-5` cho tác vụ phụ**: phân loại ý định, trích xuất sở thích sau đơn/đánh giá, tóm tắt hội thoại dài, tóm tắt review. Chi phí ước tính **≈ ¥2 mỗi đơn** (~0,15% giá trị đơn) — xem [mục 11](docs/11-cost-estimate.md).

| Khía cạnh | Hệ thống cũ | Agentic AI Commerce |
|---|---|---|
| Thao tác của khách | Tìm, lọc, chọn option, giờ, địa chỉ, thanh toán: ~15–25 lần chạm | 1–4 câu chat + **1 lần bấm "Xác nhận & Thanh toán"** |
| Tìm món | Từ khóa + bộ lọc thủ công | Câu mơ hồ → Claude dịch thành query + filters Algolia → rerank cá nhân hóa |
| Gặp trở ngại | Khách tự tìm lại từ đầu | Claude tự lập lại kế hoạch, giữ nguyên phần đã chốt |
| Cá nhân hóa | Lịch sử đơn (nếu có) | Hồ sơ khẩu vị có suy giảm theo thời gian, học từ đơn/đánh giá/món bị bỏ |
| An toàn dị ứng | Khách tự đọc nhãn | Ràng buộc cứng ở 3 lớp phía backend |
| Tái sử dụng | — | Giữ nguyên React, Node.js, Algolia, Entra ID, REST/GraphQL; thêm Agent Service, Preference store, bảng log |

**Nguyên tắc thiết kế cốt lõi**

1. **Claude đề xuất và điều phối, backend quyết định con số**: giá, thuế, tổng tiền, khả dụng, dị ứng luôn tính/kiểm tra lại ở server.
2. **Human-in-the-loop không thể vượt qua**: Claude chỉ gọi được `request_payment_confirmation`; `execute_payment`, `create_order`, `create_invoice`, `send_order_email` không nằm trong danh sách tool của Claude, chỉ chạy sau khi backend nhận `confirmation_token` hợp lệ sinh ra từ cú bấm nút.
3. **Agent không có quyền riêng**: mọi tool chạy với danh tính người dùng đang chat (`user_id` lấy từ access token, không bao giờ từ tham số Claude sinh ra).
4. **Mọi thứ đều có audit trail**: tóm tắt suy nghĩ của Claude, mọi tool call (input, output, thời gian), token và chi phí mỗi lượt.
5. **Đổi model không đổi logic**: Agent chỉ phụ thuộc interface `LLMProvider`.
