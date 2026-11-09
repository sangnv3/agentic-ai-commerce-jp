# 10. Code skeleton

Code thật nằm trong repo; tài liệu này giải thích cấu trúc và các điểm quan trọng.
Trạng thái: `backend` và `frontend` **typecheck sạch** (TypeScript strict) và build được; test thuế **pass**; backend đã chạy end-to-end trên PostgreSQL + Redis thật với smoke test **38/38** (không gọi Claude — xem [LOCAL-DEV.md](LOCAL-DEV.md)). Thanh toán dùng `DemoPaymentGateway` (chưa nối PSP thật); hóa đơn xuất dạng HTML.

```
backend/                             Node.js ≥ 20.6 + TypeScript (ESM)
├── .env.dev.example / .env.example  cấu hình local / production (không chứa bí mật)
├── db/migrations/                   001_init.sql, 002_pgvector.sql (tùy chọn) — npm run migrate
├── dev/chat.ts, dev/genKeys.ts      chat trong terminal; sinh khóa ký token
└── src/
    ├── server.ts                    Express: /api/*, /healthz, phục vụ frontend/dist, tắt êm khi redeploy
    ├── config.ts                    llm.*, AUTH_MODE (entra | demo), giới hạn, Redis/Postgres
    ├── auth/entra.ts, auth/demo.ts  Entra ID JWT / demo token → users (bảng users, cache Redis)
    ├── http/                        asyncHandler, CSRF cookie, rate limit, security headers
    ├── routes/                      auth, agent (SSE), checkout (nút xác nhận), account (giỏ, đơn, hóa đơn, APPI)
    ├── llm/                         ★ LLMProvider + AnthropicProvider (Haiku 5.5), pricing, budget (theo user + toàn hệ thống)
    ├── agent/                       ★ loop, tools (14), systemPrompt, context, lightTasks (Haiku), sanitize, sessionStore
    ├── commerce/                    ★ module bán hàng trên PostgreSQL:
    │   ├── catalog.ts               menu, tồn kho, tìm kiếm dự phòng khi không có Algolia
    │   ├── customers.ts             người dùng, địa chỉ, PTTT, sở thích, ngữ cảnh cho Claude
    │   ├── delivery.ts              vùng giao (mã bưu điện), khung giờ, giờ đóng đơn, sức chứa
    │   ├── cart.ts                  giỏ, kiểm tra dị ứng, coupon, tóm tắt thanh toán + thuế 8%/10% + checkout_hash
    │   ├── orders.ts                execute_payment (xác minh token), create_order, 適格請求書, email outbox
    │   ├── payments.ts              PaymentGateway (Demo; thêm adapter PSP thật)
    │   └── settings.ts              vùng giao, khung giờ, coupon, thông tin bên phát hành hóa đơn
    ├── checkout/                    ★ confirmation (token ES256 từ nút bấm) + fulfillment (payment → order)
    ├── jobs/postOrder.ts            create_invoice → send_order_email → học sở thích (Haiku); tự chạy lại sau restart
    ├── search/                      ranker (Algolia + cá nhân hóa + ràng buộc cứng), syncAlgolia
    ├── db/                          pool, migrate, seed, sampleData
    ├── pricing/tax.ts               thuế theo quy tắc 適格請求書 (+ test)
    └── audit/log.ts                 agent_logs append-only, chuỗi băm, token & chi phí

frontend/                            ReactJS 18 + Vite
└── src/
    ├── auth/AuthProvider.tsx        đăng nhập demo (mật khẩu) hoặc Entra ID (MSAL redirect) theo /api/auth/config
    ├── api/client.ts                fetch cùng origin + Bearer token + CSRF
    ├── hooks/useAgentStream.ts      đọc SSE; send, retry, reportCheckout
    ├── components/AgentChat.tsx     khung chat, chip, thẻ món, giỏ mini
    ├── components/CheckoutConfirmation.tsx  ★ màn hình xác nhận & nút "確認して支払う"
    ├── components/OrdersPanel.tsx   lịch sử đơn, xem hóa đơn
    └── App.tsx, styles.css          khung ứng dụng, banner demo, đổi ngôn ngữ JA/EN
```

## 10.1 Kết nối Claude API — [anthropicProvider.ts](../backend/src/llm/anthropicProvider.ts)

```ts
// SDK tự đọc key từ ANTHROPIC_API_KEY (.env khi dev, Key Vault ở production). Không bao giờ viết key vào code.
const client = new Anthropic({ maxRetries: 0, timeout: config.llm.requestTimeoutMs });

const stream = client.beta.messages.stream({
  model: "claude-haiku-5-5",                                   // config.llm.mainModel (nhẹ, rẻ nhất)
  max_tokens: 16000,
  system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
  tools: LLM_TOOLS,                                            // 14 tool; không có execute_payment / create_order
  messages,                                                    // append-only
  cache_control: { type: "ephemeral" },                        // cache luôn phần đầu hội thoại
  thinking: { type: "adaptive", display: "summarized" },       // tóm tắt suy nghĩ → audit log
  output_config: { effort: "medium" },
  // betas + fallbacks: "default" chỉ được thêm khi LLM_MAIN_MODEL là Sonnet/Opus (Haiku không có server-side fallback)
}, { signal });                                                // timeout cả lượt
stream.on("text", (delta) => onText(delta));                   // → SSE text_delta
const message = await stream.finalMessage();
```

| Quyết định | Lý do |
|---|---|
| Retry tự viết (SDK `maxRetries: 0`), exponential backoff + jitter, tôn trọng `retry-after` | Chỉ retry **khi chưa stream chữ nào** tới khách (nếu không sẽ lặp chữ); hết retry → `LLMUnavailableError` → thông báo lịch sự |
| Phân loại lỗi | 429 → `rate_limited`, 529 → `overloaded`, 5xx khác, mạng, timeout → retry; 4xx → không retry (lỗi cấu hình/code) |
| `claude-haiku-5-5` cho agent | Ưu tiên chi phí: rẻ hơn Sonnet ~15 lần trên mỗi đơn (docs/11). An toàn không phụ thuộc model vì backend ép mọi ràng buộc. Đổi sang Sonnet chỉ cần đặt `LLM_MAIN_MODEL` |
| `effort: "medium"` | Giữ độ tin cậy khi gọi nhiều tool trên model nhỏ; thử `low` cho chat thường bằng evals (docs/11) |
| `thinking.display: "summarized"` | Phần suy nghĩ (adaptive thinking, mặc định bật trên Haiku 5.5) trả về dạng khối `thinking`; bản tóm tắt được ghi vào `agent_logs.decision_rationale`, không hiển thị cho khách |
| Không có `fallbacks` khi dùng Haiku | Haiku 5.5 không hỗ trợ server-side fallback; khi bị từ chối → thông báo lịch sự + luồng thường. Code tự thêm `fallbacks: "default"` nếu đổi sang Sonnet/Opus |
| Không đặt `tool_choice` | Mặc định `auto`: Claude tự quyết gọi tool nào |
| Tác vụ nhẹ: `client.messages.parse` + `zodOutputFormat` trên `claude-haiku-5-5`, `effort: "low"` | Structured output được validate theo schema; Haiku mặc định có suy nghĩ nên `max_tokens` chừa chỗ cho phần đó |

## 10.2 Vòng lặp Agent — [loop.ts](../backend/src/agent/loop.ts)

```ts
if (!(await hasBudget(user.userId))) → thông báo lịch sự + luồng thường
await maybeSummarize(session)                          // > 60k token → Haiku tóm tắt → epoch mới
messages.push({ role: "user", content: [turn_context, customer_context?, text] })
void classifyIntent(text)                              // Haiku, song song, không chặn

for (iter < 12) {
  const turn = await llm.agentTurn({ system, tools, messages, onText, signal })   // ①② suy nghĩ + quyết định
  messages.push({ role: "assistant", content: turn.content })                    // nguyên văn
  audit(thinkingSummaries, planned_tools, tokens, cost)
  if (stop_reason !== "tool_use") break                                          // ⑤ câu trả lời đã stream
  results = await Promise.all(toolUses.map(t => executeTool(t.name, t.input, ctx)))   // ③ backend
  messages.push({ role: "user", content: results })                              // ④ quan sát
}
catch → event error {message: thông báo lịch sự theo ngôn ngữ, fallback_url: "/order"}; repairHistory()
```

- **Sự kiện nền tảng** (kết quả thanh toán) đi vào dưới dạng message `role: "system"` đặt sau một lượt user — khách không giả mạo được.
- **Giới hạn**: 12 vòng, 30 tool call, timeout 90 giây/lượt (`AbortSignal.timeout`), 45 giây/lời gọi Claude, hạn mức ngày theo người dùng.

## 10.3 Tool executor — [tools.ts](../backend/src/agent/tools.ts)

```ts
export async function executeTool(name, rawInput, ctx) {
  const resolved = findToolIgnoringCase(name)            // allowlist; tên sai → danh sách tên đúng
  const parsed = def.schema.safeParse(rawInput)          // Zod — không tin input Claude truyền vào
  const result = await def.run(parsed.data, ctx)         // ctx.user lấy từ access token
  if (def.mutatesCart && result.ok) invalidateForUser()  // giỏ đổi → confirmation cũ vô hiệu
}
```

`search_menu` minh họa nguyên tắc **"Claude chỉ làm bộ lọc chặt hơn, không làm lỏng hơn"**: dị ứng = profile ∪ dị ứng thêm trong phiên ∪ do Claude yêu cầu; vùng giao lấy từ server; sau Algolia còn đọc lại dị ứng từ DB.

## 10.4 Human-in-the-loop & `confirmation_token`

```
Claude: request_payment_confirmation(cart_version, checkout_hash)
   └─ server tính lại checkout → khớp → confirmation_request (KHÔNG có token) → SSE confirmation_required
UI:   bấm nút → POST /api/checkout/confirm (Bearer + Origin + CSRF + Idempotency-Key)
   └─ đọc lại giỏ → issueConfirmationToken(): đúng user? còn hạn? version/hash/total khớp?
      └─ JWT ES256 {sub, cart_id, cart_version, checkout_hash, total, jti, exp=5'}  ← không bao giờ tới Claude
         └─ runCheckout(): claim idempotency key → execute_payment → create_order
            → queue: create_invoice → send_order_email → học sở thích (Haiku)
UI:   POST …/messages {event: checkout_result, confirmation_request_id}
   └─ server đọc kết quả thật (một lần) → system message → Claude báo mã đơn / lập lại kế hoạch
```

## 10.5 React

- [useAgentStream.ts](../frontend/src/hooks/useAgentStream.ts): đọc SSE từ `fetch().body` (EventSource không gửi được POST); reducer xử lý `text_delta`, `tool_status`, `item_cards`, `quick_replies`, `cart_updated`, `confirmation_required`, `confirmation_invalidated`, `handoff_suggested`, `error`.
- [AgentChat.tsx](../frontend/src/components/AgentChat.tsx): không gửi khi đang gõ IME tiếng Nhật; lý do gợi ý hiển thị từ mã (nhãn cố định, không phải text tự do của Claude); hiển thị thông báo lịch sự của server khi Claude không khả dụng; luôn có link "通常の注文画面".
- [CheckoutConfirmation.tsx](../frontend/src/components/CheckoutConfirmation.tsx): summary lấy từ server; `Idempotency-Key` mỗi màn hình; nút bật sau 1 giây; tổng tiền ngay trên nút; có kết quả thì gọi `onResult` để Claude báo trong chat.

## 10.6 Chạy thử & deploy

- Chạy ở local: [LOCAL-DEV.md](LOCAL-DEV.md)
- Deploy Railway qua GitHub: [DEPLOY-RAILWAY.md](DEPLOY-RAILWAY.md)

Phần còn phải làm để chạy thật (không phải demo): adapter PSP thật (thẻ, PayPay, 3-D Secure, webhook, đối soát), menu thật với đủ dữ liệu dị ứng, App Registration Entra ID, email ACS với domain đã xác thực, xuất hóa đơn PDF, bộ evals cho chất lượng hội thoại, (màn hình "Sở thích của tôi" đã có: `frontend/src/components/PreferencesPanel.tsx`, API `GET/PUT/DELETE /api/me/preferences`).
