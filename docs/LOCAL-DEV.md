# Chạy & test ở local

Hệ thống gồm **backend Node.js** (API, agent Claude, menu/giỏ/đơn/thanh toán/hóa đơn trên PostgreSQL) và **frontend ReactJS**. Ở local:

| Thành phần | Ở local |
|---|---|
| Claude API | **Thật** — cần `ANTHROPIC_API_KEY` (~¥2/đơn với Haiku 5.5) |
| PostgreSQL, Redis | Docker (`docker-compose.yml`, cổng 5433 / 6380) |
| Menu, giỏ, đơn, hóa đơn | Code thật trong backend, dữ liệu mẫu nạp bằng `npm run dev:seed` |
| Algolia | Algolia thật (nếu điền App ID + Search key) hoặc tìm kiếm trên PostgreSQL (nếu để trống) |
| Đăng nhập | `AUTH_MODE=demo`: mật khẩu chung, mỗi lần đăng nhập là một khách mẫu riêng (bản sao của 田中 健太) |
| Thanh toán | `PAYMENT_PROVIDER=demo`: thẻ luôn thành công, **PayPay luôn thất bại** (để thử nhánh lỗi), không có tiền thật |
| Email | In ra console của backend |

## 1. Chuẩn bị (một lần)

**Node.js ≥ 20.6** (máy hiện có Node 12):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# mở terminal mới
nvm install 22 && nvm use 22
```

```bash
docker compose up -d                     # Redis + PostgreSQL

cd backend
npm install
cp .env.dev.example .env                 # điền ANTHROPIC_API_KEY (và Algolia nếu dùng)
npm run dev:keys                         # khóa ký confirmation token → dev/keys/ (git-ignored)
npm run dev:migrate                      # tạo bảng
npm run dev:seed                         # 4 nhà hàng, 10 món mẫu

cd ../frontend
npm install
```

> Nếu trước đây đã chạy phiên bản cũ (có `dev:mock`), xóa DB cũ một lần: `docker compose down -v && docker compose up -d`, rồi chạy lại `dev:migrate` + `dev:seed`.

## 2. Chạy

```bash
# Terminal 1
cd backend && npm run dev            # API trên :8080 (log, email in ở đây)

# Terminal 2
cd frontend && npm run dev           # giao diện trên http://localhost:5173 (proxy /api → :8080)
```

Mở http://localhost:5173 → mật khẩu demo là giá trị `DEMO_PASSWORD` trong `.env` (mặc định `demo`). Màn hình đầu là **trang chủ**: menu 75 món chia theo danh mục (寿司, 天ぷら, 麺類, 丼・定食, カレー, 弁当…), ô nhập yêu cầu và nút **AIに注文をお願いする**. Tab **会話履歴** liệt kê các cuộc trò chuyện đã lưu — mở lại để xem và chat tiếp.

Không cần giao diện? Chat trong terminal: `cd backend && npm run dev:chat` (gõ `y` để "bấm" nút xác nhận thanh toán).

## 3. Kịch bản nên thử

Khách mẫu: **田中 健太**, dị ứng **えび・かに**, thường đặt 12:00 giao văn phòng Shibuya, từng chấm ★5 món 鶏むね肉と温野菜の蒸し定食, không thích 麻婆豆腐 (cay).

| # | Bạn gõ | Kỳ vọng |
|---|---|---|
| 1 | *(lời chào)* → `はい、いつも通りで` → `軽めで油少なめ、1,500円以下` → `ご飯少なめで緑茶もつけて` → bấm **確認して支払う** | Gợi ý 2–3 món, tự thêm 定食, áp LUNCH100, tổng **¥1,570** (8%: ¥1,240 / thuế ¥91; 10%: ¥330 / thuế ¥30); mã đơn trong chat; email in ở Terminal 1; tab **注文履歴** → **領収書** xem hóa đơn 適格請求書 |
| 1b | Trang chủ → bấm ví dụ **サーモン入りの寿司、1人前、5,000円以下** | Chatbot tự tìm món sushi có cá hồi trong ngân sách, thêm vào giỏ, áp coupon và mở luôn màn hình xác nhận — chỉ cần bấm **確認して支払う** |
| 1c | Trang chủ → gõ `I want salmon sushi for 1 person under $5` | Quy đổi $5 ≈ ¥750, chọn món ≤ ¥750 (ví dụ サーモン握り ¥480) |
| 1d | Tab **会話履歴** → **開く** một cuộc cũ → hỏi tiếp | Hiện lại toàn bộ tin nhắn, thẻ món, mã đơn; agent trả lời tiếp với đúng ngữ cảnh cũ |
| 2 | `今日は12:30でお願いします` | 12:30 luôn đầy (`DEMO_FULL_SLOTS`) → agent đề xuất khung khác |
| 3 | `〒220-0012 横浜市西区みなとみらい3-3-1 に届けて` | Ngoài vùng giao → gợi ý địa chỉ đã lưu |
| 4 | `海老天丼にして` | Bị từ chối (dị ứng えび); backend trả `ALLERGEN_CONFLICT` dù agent có cố |
| 5 | Ở màn hình xác nhận → **内容を変更する** → `支払いはPayPayで` → bấm xác nhận | PayPay thất bại → agent báo **không bị trừ tiền**, giữ giỏ, gợi ý thẻ VISA |
| 6 | `npm run dev:seed -- --stock itm_1021=0`, rồi `いつもの鶏の蒸し定食で` | Hết món → agent tự tìm món tương đương |
| 7 | `冷たいそばある？` | Có ざるそば — mô tả chứa câu prompt injection; agent không làm theo |
| 8 | `支払って` khi chưa bấm nút | Agent nói phải bấm nút trên màn hình xác nhận |
| 9 | Ở màn hình xác nhận → `やっぱり2つにして` | Giỏ đổi → màn hình xác nhận cũ vô hiệu, agent tạo màn hình mới |
| 10 | Đặt key sai trong `.env` rồi chat | Thông báo lịch sự + nút **もう一度試す**, không crash |

Đặt `SLOT_RULES_STRICT=true` để áp dụng giờ đóng đơn / thời gian chuẩn bị thật theo giờ JST.

## 4. Xem dữ liệu

```bash
docker compose exec postgres psql -U agent -d food
```
```sql
select order_id, total, tax_8, tax_10, created_at from orders order by created_at desc limit 5;
select log_id, actor, event_type, tool_name, model, cost_usd from agent_logs order by log_id desc limit 30;
select log_id, left(decision_rationale, 300) from agent_logs where decision_rationale is not null order by log_id desc limit 5;
select sum(cost_usd) from agent_logs where created_at > now() - interval '1 day';
```

## 5. Kiểm tra

```bash
cd backend && npm run typecheck && npm test && npm run build
cd ../frontend && npm run typecheck && npm run build
docker build -t agentic-food-ordering .      # ở thư mục gốc: đúng image Railway sẽ chạy
```

## 6. Sự cố thường gặp

| Vấn đề | Cách xử lý |
|---|---|
| `node: bad option: --env-file` | Node < 20.6 → `nvm use 22` |
| `ECONNREFUSED ...:6380 / :5433` | `docker compose up -d` |
| `relation "..." does not exist` | `npm run dev:migrate` (DB cũ: `docker compose down -v` trước) |
| `No confirmation signing key configured` | `npm run dev:keys` |
| Trang báo "Cannot reach the server" | Backend chưa chạy ở :8080 |
| Agent báo lỗi lịch sự ngay từ lời chào | Kiểm tra `ANTHROPIC_API_KEY`; xem log backend và `agent_logs` (event `error`) |
