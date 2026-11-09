# 2. Kiến trúc tổng thể · 3. Vòng lặp Agent · 4. Sequence diagram

## 2.1 Sơ đồ kiến trúc

```mermaid
flowchart LR
  subgraph Client["Trình duyệt"]
    UI["React SPA<br/>(MSAL React, Chat UI,<br/>thẻ món, mini cart, màn hình xác nhận)"]
  end

  subgraph Identity["Microsoft Entra ID"]
    ENTRA["OIDC / OAuth2<br/>access token api://food-ordering"]
  end

  subgraph Edge["API Gateway / BFF"]
    GW["Xác minh JWT (JWKS)<br/>Rate limit · CORS · CSRF"]
  end

  subgraph Agent["Agent Service (Node.js, MỚI)"]
    LOOP["Agent Loop<br/>(SSE stream, giới hạn vòng,<br/>timeout, ngân sách)"]
    PROV["LLMProvider<br/>(adapter: model, retry/backoff,<br/>prompt caching, tính chi phí)"]
    TOOLS["Tool Executor<br/>(allowlist, Zod validate,<br/>chạy với quyền user)"]
    CTX["Context Manager<br/>(customer context,<br/>tóm tắt hội thoại dài)"]
    RANK["Ranker<br/>(Algolia + cá nhân hóa<br/>+ ràng buộc cứng)"]
    GUARD["Guardrails<br/>(đánh dấu untrusted data)"]
    CONF["Confirmation & Fulfillment<br/>(token từ nút bấm →<br/>payment → order)"]
  end

  subgraph Anthropic["Claude API (Anthropic)"]
    AGENTLLM["claude-haiku-5-5 (agent)<br/>suy nghĩ · lập kế hoạch · gọi tool"]
    HAIKU["claude-haiku-5-5 (tác vụ nhẹ)<br/>ý định · trích xuất sở thích · tóm tắt"]
  end

  subgraph Commerce["Commerce API (Node.js, HIỆN CÓ)"]
    GQL["GraphQL<br/>(menu, cart, profile,<br/>inventory, preferences)"]
    REST["REST<br/>(payments, orders, invoices,<br/>webhooks)"]
    PRICING["Pricing & Tax<br/>(8% / 10%)"]
    SLOT["Slot & Delivery Area"]
  end

  subgraph Data["Lưu trữ"]
    PG[("PostgreSQL<br/>users, menu, carts, orders,<br/>payments, invoices")]
    PREF[("Preference Store<br/>PostgreSQL + pgvector")]
    LOG[("agent_logs<br/>append-only, có chi phí")]
    REDIS[("Redis<br/>chat session, idempotency,<br/>budget, lock")]
    BLOB[("Blob Storage<br/>hóa đơn PDF")]
  end

  subgraph External["Dịch vụ ngoài"]
    ALG["Algolia"]
    PSP["Payment Gateway<br/>(Thẻ, PayPay, ví, B2B 後払い)"]
    MAIL["Azure Communication<br/>Services Email"]
    KV["Azure Key Vault<br/>(ANTHROPIC_API_KEY,<br/>khóa ký token)"]
  end

  QUEUE[["Job Queue<br/>(invoice, email,<br/>học sở thích)"]]

  UI -- "Login (PKCE)" --> ENTRA
  UI -- "Bearer token" --> GW
  GW -- "SSE /agent/sessions/:id/messages" --> LOOP
  GW -- "GraphQL / REST" --> GQL
  GW -- "POST /checkout/confirm<br/>(nút bấm)" --> CONF
  LOOP --> PROV
  LOOP --> CTX
  PROV <-- "HTTPS + API key" --> AGENTLLM
  PROV <--> HAIKU
  KV -. "Managed Identity" .-> PROV
  LOOP --> TOOLS
  TOOLS --> GUARD
  TOOLS --> RANK
  RANK --> ALG
  TOOLS -- "token của user" --> GQL
  CTX --> GQL
  CONF --> REST
  GQL --> PG
  GQL --> PREF
  REST --> PRICING
  REST --> SLOT
  REST --> PSP
  PSP -- "webhook" --> REST
  CONF --> QUEUE
  QUEUE --> REST
  QUEUE --> BLOB
  QUEUE --> MAIL
  QUEUE --> HAIKU
  QUEUE --> PREF
  LOOP --> REDIS
  CONF --> REDIS
  TOOLS --> LOG
  LOOP --> LOG
  CONF --> LOG
  PG -. "CDC / sync job" .-> ALG
```

### Vai trò từng thành phần

| Thành phần | Vai trò | Mới / Tái sử dụng |
|---|---|---|
| React SPA | Chat UI, thẻ gợi ý, mini cart, màn hình xác nhận; MSAL React đăng nhập Entra ID. Không giữ API key Claude. | Tái sử dụng app, thêm module chat |
| API Gateway / BFF | Xác minh access token Entra (issuer, audience, chữ ký, `exp`, scope), rate limit, định tuyến | Tái sử dụng (thêm route) |
| **Agent Service** | Agent loop, LLMProvider, tool executor, context manager, ranker, guardrails, confirmation & fulfillment, SSE | **Mới** |
| **Claude API** | `claude-haiku-5-5` — model nhẹ, rẻ nhất — cho cả bộ não agent và tác vụ nhẹ chạy song song/nền. Có thể chuyển phần agent sang `claude-sonnet-5-5` bằng cấu hình nếu cần | **Mới** |
| Commerce API | Nguồn sự thật cho menu, tồn kho, giỏ, giá, thuế, slot, đơn hàng, thanh toán, hóa đơn | Tái sử dụng, bổ sung endpoint |
| Preference Store | Hồ sơ khẩu vị có cấu trúc + event log + embedding (pgvector) | **Mới** (trên PostgreSQL sẵn có) |
| Algolia | Full-text + facet + filter | Tái sử dụng, thêm thuộc tính |
| Job Queue | PDF hóa đơn, email, trích xuất sở thích (Haiku), hỏi đánh giá sau giao | Mới (BullMQ trên Redis hoặc Azure Service Bus) |
| Key Vault | `ANTHROPIC_API_KEY`, khóa ký `confirmation_token`, khóa PSP | Tái sử dụng/mới |

### Quyết định kiến trúc chính

1. **Agent Service tách khỏi Commerce API**: deploy/rollback độc lập, giới hạn blast radius; luồng mua truyền thống vẫn chạy song song và là phương án dự phòng khi Claude không khả dụng.
2. **Chỉ backend gọi Claude**: `ANTHROPIC_API_KEY` đọc từ biến môi trường (Key Vault reference qua Managed Identity ở production). Mọi lời gọi đi qua `LLMProvider` — một chỗ duy nhất cho model, effort, timeout, retry/backoff, prompt caching và tính chi phí.
3. **Agent gọi Commerce API với ngữ cảnh người dùng**: chuyển tiếp access token của người dùng (hoặc On-Behalf-Of nếu khác audience). Commerce API phân quyền như với request từ UI → Claude **không bao giờ có nhiều quyền hơn người dùng**.
4. **Thanh toán đi đường riêng**: `POST /checkout/confirm` (từ nút UI) → token → `execute_payment` → `create_order`. Claude chỉ nhận *kết quả* qua system message của nền tảng.
5. **Hậu xử lý bất đồng bộ**: hóa đơn, email, học sở thích chạy trong queue có retry; lỗi mail không làm hỏng đơn hàng.

---

## 3. Vòng lặp Agent — Claude suy nghĩ, backend thực thi

```mermaid
flowchart TD
  START([Tin nhắn của khách<br/>hoặc sự kiện nền tảng]) --> GUARDS{Ngân sách hôm nay<br/>còn không?}
  GUARDS -- hết --> FALLBACK[Thông báo lịch sự +<br/>link màn hình đặt món thường]
  GUARDS -- còn --> CTXM[Context Manager:<br/>• tóm tắt nếu hội thoại quá dài (Haiku)<br/>• thêm turn_context, customer_context]
  CTXM --> INTENT[[Haiku: phân loại ý định<br/>song song, không chặn]]
  CTXM --> THINK

  subgraph LOOP["Lặp tối đa 12 vòng · 30 tool call · 90 giây / lượt"]
    THINK["① Claude Haiku 5.5 suy nghĩ & lập kế hoạch<br/>đọc tin nhắn, ngữ cảnh, sở thích → thiếu gì? bước nào? thứ tự?"]
    THINK --> DECIDE{"② Claude trả về gì?"}
    DECIDE -- "tool_use<br/>(1 hoặc nhiều tool)" --> EXEC
    EXEC["③ Backend thực thi<br/>allowlist → Zod validate → quyền của user<br/>→ ép ràng buộc cứng → Algolia / DB / Commerce API<br/>→ đánh dấu untrusted data → ghi audit"]
    EXEC --> OBS["④ Kết quả tool (JSON, ok / error code)<br/>gửi lại cho Claude trong 1 message"]
    OBS --> THINK
  end

  DECIDE -- "end_turn (câu trả lời)" --> ANSWER["⑤ Câu trả lời tự nhiên<br/>stream từng token về khung chat (SSE)"]
  DECIDE -- "refusal / lỗi / quá tải<br/>(sau retry có backoff)" --> FALLBACK
  ANSWER --> SAVE[(Lưu lịch sử append-only,<br/>token, chi phí, tóm tắt suy nghĩ)]

  EXEC -. "request_payment_confirmation" .-> SCREEN[/"Màn hình xác nhận<br/>(SSE confirmation_required)"/]
  SCREEN -. "👤 KHÁCH BẤM NÚT<br/>(ngoài vòng lặp của Claude)" .-> PAY["Backend: token → execute_payment<br/>→ create_order → queue: invoice, email"]
  PAY -. "system message:<br/>checkout_captured / failed" .-> START
```

**Cách Claude tự lập lại kế hoạch** — ví dụ trong bước ④:

| Kết quả tool | Claude làm gì tiếp (không bắt khách làm lại) |
|---|---|
| `add_to_cart` → `ITEM_SOLD_OUT` | `check_inventory` các món cùng quán/cùng tag → `search_menu` món tương đương → đề xuất 1–2 món, giữ nguyên giờ + địa chỉ |
| `check_delivery_slot` → `FULL` + `alternatives` | Đề xuất 2–3 khung gần nhất, giữ món đã chọn |
| `prepare_checkout` → tổng vượt ngân sách khách nói | Bỏ đồ uống / đổi size / thay món phụ, gọi `update_cart`, giải thích ngắn |
| `validate_address` → `OUT_OF_SERVICE_AREA` | Đọc lại địa chỉ đã chuẩn hóa, gợi ý địa chỉ đã lưu trong vùng giao |
| `update_cart` → `CART_VERSION_CONFLICT` (khách vừa sửa trên UI) | `get_cart` rồi thực hiện lại thao tác trên phiên bản mới |

**Tham số gọi Claude** (chi tiết ở [10-code-skeleton.md](10-code-skeleton.md)): `claude-haiku-5-5`, adaptive thinking với `display: "summarized"` (tóm tắt suy nghĩ để audit, không hiển thị cho khách), `effort: "medium"` (giữ độ tin cậy khi gọi nhiều tool trên model nhỏ; thử `low` bằng evals), prompt caching cho system prompt + tools + phần đầu hội thoại, `tool_choice` mặc định `auto`.

---

## 4. Sequence diagram — luồng đặt món end-to-end

```mermaid
sequenceDiagram
  autonumber
  actor U as Khách hàng
  participant FE as React SPA
  participant EN as Entra ID
  participant AG as Agent Service
  participant S as Claude Haiku 5.5 (agent)
  participant H as Claude Haiku 5.5 (tác vụ nhẹ)
  participant CM as Commerce API
  participant AL as Algolia
  participant PSP as Payment Gateway
  participant Q as Job Queue
  participant ML as Email Service

  U->>FE: Mở trang
  FE->>EN: Đăng nhập OIDC (PKCE)
  EN-->>FE: access_token
  FE->>AG: POST /agent/sessions → POST …/messages (rỗng = bắt đầu)
  AG->>AG: Xác minh JWT, kiểm tra ngân sách
  AG->>CM: agentContext (profile, sở thích, giỏ dở dang)
  AG->>S: system + tools (cached) + customer_context
  S-->>AG: Lời chào cá nhân hóa (stream)
  AG-->>FE: SSE: "田中様、こんにちは。今日も渋谷オフィスに12:00でよろしいですか？"

  U->>FE: "はい。軽めで油少なめ、1,500円以下"
  FE->>AG: POST …/messages (SSE)
  par Không chặn
    AG->>H: classify intent → order_flow
  and Vòng lặp agent
    AG->>S: messages + tools
    Note over S: Suy nghĩ: giờ + địa chỉ đã rõ,<br/>cần kiểm tra slot & vùng, rồi tìm món
    S-->>AG: tool_use: check_delivery_slot, validate_address (song song)
    AG->>CM: slot (cutoff, prep time, sức chứa) · địa chỉ trong vùng
    CM-->>AG: OK
    AG->>S: tool_results
    S-->>AG: tool_use: search_menu(query="蒸し 鶏 あっさり", max_price=1500, taste=[light, low_oil])
    AG->>AG: Ép dị ứng/chế độ ăn/vùng/slot vào filters
    AG->>AL: query + filters + facets
    AL-->>AG: hits
    AG->>CM: đọc lại dị ứng từ DB (hậu kiểm)
    AG->>AG: Rerank, bọc <untrusted_data>
    AG-->>FE: SSE item_cards
    AG->>S: tool_result (top 5)
    S-->>AG: tool_use: add_to_cart(itm_1021, options)
    AG->>CM: add_to_cart (kiểm tra dị ứng lần 3, tồn kho)
    AG-->>FE: SSE cart_updated
    AG->>S: tool_result
    S-->>AG: tool_use: apply_coupon(auto) → prepare_checkout → request_payment_confirmation
    AG->>CM: tính giá, thuế 8%/10%, phí giao, PTTT mặc định
    AG->>AG: Tạo confirmation_request (cart_version, checkout_hash, total) — KHÔNG có token
    AG-->>FE: SSE confirmation_required
    S-->>AG: Câu trả lời: 3 lựa chọn + "đã thêm món 1 vào giỏ"
    AG-->>FE: SSE text (stream)
  end

  rect rgb(255, 235, 205)
    Note over U,FE: ⚠️ HUMAN-IN-THE-LOOP — bước duy nhất con người bắt buộc làm
    FE->>AG: GET /checkout/confirmation-requests/{id} (summary do server tính)
    FE->>U: Món, SL, giá, thuế 8%/10%, phí giao, tổng, giờ, địa chỉ, PTTT
    U->>FE: Bấm nút "確認して支払う / Xác nhận & Thanh toán"
    FE->>AG: POST /checkout/confirm + Bearer + CSRF + Idempotency-Key
    AG->>CM: Đọc lại giỏ (version, hash, total)
    AG->>AG: Khớp? → mint confirmation_token (ES256, 1 lần, 5 phút)<br/>Token không bao giờ vào ngữ cảnh của Claude
  end

  AG->>CM: execute_payment(token, idempotency key)
  CM->>CM: Xác minh token lần 2, khóa giỏ, kiểm lại tồn & slot
  CM->>PSP: Authorize + capture (cùng idempotency key)
  alt PayPay / 3-D Secure
    PSP-->>FE: redirect / app switch → webhook về CM
  end
  PSP-->>CM: Thành công
  AG->>CM: create_order (idempotent) → order_id
  AG-->>FE: 200 {status: captured, order_id}
  AG->>Q: enqueue: create_invoice → send_order_email → học sở thích
  FE->>AG: POST …/messages {event: checkout_result, confirmation_request_id}
  AG->>AG: Đọc kết quả THẬT từ server (client không tự khai được)
  AG->>S: system message: checkout_captured {order_id}
  S-->>AG: "ご注文が確定しました。注文番号: A-20261109-0042…"
  AG-->>FE: SSE text

  Q->>CM: create_invoice → PDF 適格請求書 → Blob
  Q->>ML: send_order_email (template JA, đính kèm PDF)
  ML-->>U: Email xác nhận
  Q->>H: Trích xuất tín hiệu sở thích từ đơn (structured output)
  Q->>CM: Lưu preference_events

  Note over Q,U: Sau giờ giao + 30 phút
  FE->>U: "お味はいかがでしたか？ ★1–5"
  U->>FE: ★★★★☆ "少し味が薄い"
  FE->>AG: POST /agent/feedback
  AG->>H: Trích xuất (saltiness +) — không bao giờ tự suy ra dị ứng
  AG->>CM: preference_events
```

### Điểm then chốt

- **Khung cam** là điểm human-in-the-loop. Token sinh **sau** cú bấm nút và không xuất hiện trong bất kỳ ngữ cảnh nào Claude đọc được.
- **Kiểm tra độc lập ở Commerce API**: dù Agent Service bị chiếm quyền, Commerce API vẫn xác minh chữ ký token (khóa trong Key Vault).
- **Báo kết quả cho Claude an toàn**: trình duyệt chỉ gửi `confirmation_request_id`; Agent Service đọc kết quả thật phía server và đưa vào hội thoại bằng **system message** của nền tảng — khách không thể giả mạo "đã thanh toán".
- **Idempotency**: key do FE sinh một lần khi mở màn hình xác nhận; bấm 2 lần / mạng chập chờn / retry đều trả cùng kết quả, không trừ tiền 2 lần, không tạo 2 đơn.
