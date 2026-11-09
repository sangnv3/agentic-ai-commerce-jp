# Deploy lên Railway qua GitHub

Kết quả: **1 service** (image Docker gồm frontend React + backend Node.js) + **PostgreSQL** + **Redis** trên Railway, tự build và deploy lại mỗi khi bạn push lên nhánh `main`.

```
GitHub (main) ──push──► Railway
                          ├─ app (Dockerfile)  ← frontend/dist + backend/dist, cổng $PORT, /healthz
                          │    khi khởi động: migrate DB (+ nạp dữ liệu mẫu nếu SEED_SAMPLE_DATA=true)
                          ├─ Postgres
                          └─ Redis
```

Chi phí ước tính: gói Hobby của Railway (khoảng $5/tháng, gồm một phần dung lượng sử dụng) + Claude API (≈ ¥2/đơn với Haiku 5.5, có trần `LLM_GLOBAL_DAILY_USD` mỗi ngày).

## 1. Đưa code lên GitHub

```bash
cd agentic-ai-commerce
git init -b main            # nếu chưa có
git add -A
git status                  # kiểm tra: KHÔNG được có .env, .env.bak, backend/dev/keys/
git commit -m "Agentic AI food ordering"
# Tạo repo trên GitHub (private khuyến nghị), rồi:
git remote add origin git@github.com:<you>/<repo>.git
git push -u origin main
```

`.gitignore` đã chặn `.env`, `.env.*` (trừ 2 file mẫu), `node_modules/`, `dist/`, `backend/dev/keys/`.

## 2. Tạo project trên Railway

1. railway.com → **New Project** → **Deploy from GitHub repo** → chọn repo. Railway đọc `railway.json` ở thư mục gốc và build bằng `Dockerfile`.
2. Trong project: **+ New → Database → PostgreSQL**, rồi **+ New → Database → Redis**.
3. Mở service app → **Settings → Networking → Generate Domain** (ví dụ `xxx.up.railway.app`). Biến `RAILWAY_PUBLIC_DOMAIN` được set tự động và backend dùng nó làm origin hợp lệ cho CSRF/Origin check.

## 3. Biến môi trường (service app → Variables → Raw Editor)

Tạo trước 3 giá trị bí mật trên máy bạn:

```bash
cd backend
npm run dev:keys -- --print        # → CONFIRMATION_SIGNING_KEY_PEM (một dòng, có \n)
openssl rand -hex 32               # → DEMO_AUTH_SECRET
# DEMO_PASSWORD: tự đặt một mật khẩu demo đủ dài để chia sẻ cho người dùng thử
```

Dán vào Raw Editor (thay `<...>`):

```bash
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}

ANTHROPIC_API_KEY=<API key Claude MỚI — không dùng key đã lộ trong chat>
LLM_MAIN_MODEL=claude-haiku-5-5
LLM_LIGHT_MODEL=claude-haiku-5-5
LLM_MAIN_EFFORT=medium
LLM_PER_USER_DAILY_USD=0.05
LLM_GLOBAL_DAILY_USD=2

AUTH_MODE=demo
DEMO_PASSWORD=<mật khẩu demo>
DEMO_AUTH_SECRET=<openssl rand -hex 32>
CONFIRMATION_SIGNING_KEY_PEM=<kết quả npm run dev:keys -- --print>

SEED_SAMPLE_DATA=true
SLOT_RULES_STRICT=true
DEMO_FULL_SLOTS=12:30
PAYMENT_PROVIDER=demo

# Tùy chọn — để trống thì tìm kiếm chạy trên PostgreSQL
ALGOLIA_APP_ID=<Application ID>
ALGOLIA_SEARCH_KEY=<Search API Key>

# Tùy chọn — để trống thì email chỉ ghi ra log
ACS_EMAIL_CONNECTION_STRING=
ACS_EMAIL_SENDER=
INVOICE_ISSUER_NAME=株式会社サンプルフード
INVOICE_ISSUER_REG_NO=T1234567890123
```

`NODE_ENV=production`, `PORT`, `WEB_DIST_DIR` đã đặt sẵn trong `Dockerfile`; Railway tự cấp `PORT`.

> Lưu ý về giờ đặt món: với `SLOT_RULES_STRICT=true`, đơn giao trưa đóng lúc 10:30 JST và cần chuẩn bị tối thiểu 45 phút — thử vào buổi tối thì agent sẽ đề xuất khung tối hoặc ngày mai. Muốn demo được mọi lúc, đặt `SLOT_RULES_STRICT=false`.

## 4. Deploy & kiểm tra

Railway build ngay sau khi lưu biến (hoặc bấm **Deploy**). Trong **Deployments → Logs** sẽ thấy:

```
[migrate] applied 001_init.sql
[migrate] applied 002_pgvector.sql        ← Postgres mặc định của Railway không có pgvector: migration tự bỏ qua, không lỗi
[seed] 4 restaurants, 10 menu items
backend listening on :8080 (auth: demo, web: /app/frontend/dist)
```

Healthcheck `/healthz` kiểm tra cả Postgres và Redis. Mở domain → đăng nhập bằng mật khẩu demo → chat thử (kịch bản gợi ý ở [LOCAL-DEV.md](LOCAL-DEV.md#3-kịch-bản-nên-thử)).

## 5. Algolia (nếu dùng)

Index `menu_items_ja` / `menu_items_en` đã có 75 món mẫu trùng với dữ liệu seed. Khi menu trong DB thay đổi, đồng bộ lại từ máy bạn, trỏ vào DB của Railway (Postgres → **Connect** → *Public Network* URL). Script gửi task rồi kết thúc ngay; Algolia áp dụng theo thứ tự trong vài giây đến vài phút (thêm `--wait` nếu muốn chờ):

```bash
cd backend
DATABASE_URL='<public URL của Railway Postgres>' ALGOLIA_APP_ID=<App ID> ALGOLIA_ADMIN_KEY=<Write key> \
  node --import tsx src/search/syncAlgolia.ts
# nếu báo lỗi SSL: thêm DATABASE_SSL=true
```

## 6. Vận hành

| Việc | Cách làm |
|---|---|
| Deploy bản mới | `git push` lên `main` → Railway tự build; CI (GitHub Actions) chạy typecheck, test, build, migration và `docker build` |
| Xem log, chi phí Claude | Railway Logs; bảng `agent_logs` (cột `cost_usd`) — Postgres → **Data** hoặc kết nối bằng psql |
| Đổi model / effort | Sửa biến `LLM_MAIN_MODEL` / `LLM_MAIN_EFFORT` → Railway redeploy |
| Tạm khóa chi tiêu Claude | Giảm `LLM_GLOBAL_DAILY_USD` (ví dụ `0`) |
| Đổi khóa ký token | Sinh khóa mới, cập nhật `CONFIRMATION_SIGNING_KEY_PEM` (màn hình xác nhận đang mở sẽ phải bấm lại) |
| Rollback | Railway → Deployments → bản trước → **Redeploy** (migration chỉ thêm, không xóa) |

## 7. Chuyển từ demo sang thật

1. **Đăng nhập Entra ID**: tạo App Registration (SPA, redirect URI = domain Railway; expose scope `api://food-ordering/Orders.ReadWrite`), rồi đặt `AUTH_MODE=entra`, `ENTRA_TENANT_ID`, `ENTRA_SPA_CLIENT_ID`, `ENTRA_API_AUDIENCE`, `ENTRA_API_SCOPE`; xóa `DEMO_*`.
2. **Thanh toán thật**: viết adapter PSP trong `backend/src/commerce/payments.ts` (GMO-PG / Stripe JP / PAY.JP, có PayPay & 3-D Secure) và đặt `PAYMENT_PROVIDER`.
3. **Menu thật**: nhập nhà hàng/món (đủ 28 chất gây dị ứng) vào DB, bỏ `SEED_SAMPLE_DATA`, chạy `algolia:sync`.
4. **Email**: Azure Communication Services (`ACS_EMAIL_CONNECTION_STRING`, `ACS_EMAIL_SENDER` với domain đã xác thực).
5. **Hóa đơn**: thông tin doanh nghiệp thật (`INVOICE_ISSUER_*`), nhờ kế toán duyệt mẫu; thêm xuất PDF nếu cần.
