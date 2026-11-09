# 9. Wireframe & mô tả UI

Bố cục desktop: chat ở giữa, mini cart cố định bên phải. Mobile: chat toàn màn hình, mini cart là thanh dính ở đáy (mở thành bottom sheet).
Ngôn ngữ mặc định tiếng Nhật, nút chuyển `日本語 / EN` ở header. Font: Noto Sans JP.

## 9.1 Khung chat

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ 🍱 BrandName      ご注文アシスタント              日本語 | EN      田中 健太 ▾   [通常の注文画面]│
├──────────────────────────────────────────────────────────────┬───────────────────────────┤
│                                                              │ 🛒 カート                   │
│  🤖 田中様、こんにちは。今日もいつものように、                │ ヘルシー食堂 渋谷店          │
│     渋谷ヒカリエのオフィスへ12:00にお届けで                   │ ───────────────────────── │
│     よろしいでしょうか？                                      │ 鶏むね肉と温野菜の蒸し定食  │
│     [はい、いつも通り] [時間を変える] [住所を変える]            │  ご飯少なめ・緑茶付き       │
│                                                              │  [-] 1 [+]      ¥1,340 🗑  │
│                                     はい、いつも通りで。 👤   │ ───────────────────────── │
│                                                              │ 小計            ¥1,340    │
│  🤖 ⏳ 配達枠を確認中…   (tool_status)                         │ クーポン         −¥100    │
│  🤖 本日12:00〜12:30の枠は空いております…                      │ 配送料            ¥330    │
│     今日はどのようなものを召し上がりたいですか？                │ 合計(税込)      ¥1,570    │
│     [軽め][がっつり][温かい][冷たい][ご飯][麺][¥1,000以下]      │ ───────────────────────── │
│                                                              │ 📅 11/9(月) 12:00–12:30    │
│  ┌ 提案カード (item_cards, cuộn ngang) ───────────────────┐   │ 📍 渋谷ヒカリエ 20F         │
│  │ [ảnh]            │ [ảnh]            │ [ảnh]           │   │ 💳 VISA ****4242           │
│  │ 鶏むね肉と温野菜…│ 鮭の塩焼きと五穀…│ 豆腐ときのこの… │   │                           │
│  │ ¥1,180 ⭐前回★5   │ ¥1,250 ⭐★4       │ ¥980 🆕          │   │ [ 内容を確認する ]          │
│  │ 🏷 油控えめ 蒸し  │ 🏷 さっぱり       │ 🏷 あっさり       │   │  (mở màn hình xác nhận)    │
│  │ ⚠ 小麦・大豆・鶏肉│ ⚠ さけ・大豆      │ ⚠ 大豆・小麦     │   └───────────────────────────┘
│  │ ✅ カートに追加済 │ [これにする]      │ [これにする]     │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│ [🎤]  メッセージを入力…（例: 軽めで1,500円以下）       [送信 ➤] │
│  AIが提案します。お支払いは確認画面のボタンでのみ行われます。     │
└──────────────────────────────────────────────────────────────┘
```

**Hành vi**
- Text Agent stream theo token; `tool_status` hiển thị dòng trạng thái nhỏ ("メニューを検索中…") rồi biến mất.
- **Quick replies** (chip) gửi qua `ui-actions` — giảm gõ phím, đặc biệt trên mobile.
- Nút "通常の注文画面" (màn hình đặt món thường) luôn có — fallback khi Agent lỗi hoặc khách muốn tự thao tác.
- **Khi Claude API lỗi/quá tải/hết hạn mức**: hiển thị một bong bóng thông báo lịch sự do server gửi (event `error.message`), ví dụ 「申し訳ございません。ただいまアシスタントが混み合っております。カートの内容は保存されています。」 kèm nút `[もう一度試す]` và `[通常の注文画面へ]`; mini cart vẫn dùng được.
- Khi Haiku phát hiện khiếu nại/sự cố an toàn thực phẩm (`handoff_suggested`): hiện dòng gợi ý liên hệ bộ phận hỗ trợ.
- Disclaimer dưới ô nhập nói rõ thanh toán chỉ qua nút xác nhận.
- Accessibility: `aria-live="polite"` cho vùng tin nhắn, focus không nhảy khi stream, hỗ trợ IME tiếng Nhật (không gửi khi `isComposing`).

## 9.2 Thẻ gợi ý món (Item card)

```
┌───────────────────────────────┐
│ [ ảnh món 16:9 ]          🆕   │
│ 鶏むね肉と温野菜の蒸し定食       │
│ ヘルシー食堂 渋谷店 · 520kcal    │
│ ¥1,180（税込）                  │
│ 💡 前回★5 · 油控えめ · 予算内     │  ← match_reasons (mã → nhãn cố định, không phải text LLM)
│ アレルゲン: 小麦 大豆 鶏肉   ⓘ  │  ← 28 mục; ⓘ mở danh sách đầy đủ + コンタミ
│ ✅ あなたのアレルギー(えび・かに)は不使用 │
│ [ 詳細 ]            [ これにする ]│
└───────────────────────────────┘
```
- Món đang ở trong giỏ: nút đổi thành `✅ カートに追加済` + `[変更]`.
- Nhãn dị ứng hiển thị bằng tên tiếng Nhật chuẩn (えび, かに, くるみ, 小麦, そば, 卵, 乳, 落花生, …); 8 mục 特定原材料 tô đậm.
- Nếu `allergen_data_complete=false`: hiển thị "一部アレルゲン情報未確認".

## 9.3 Mini cart

- Đồng bộ qua SSE `cart_updated` (hoặc GraphQL subscription `cartUpdated`).
- Dòng nào do Agent thêm có badge nhỏ `🤖 AIが追加` trong 5 giây đầu + highlight, để khách nhận ra thay đổi.
- Khách có thể sửa trực tiếp (±, xóa) — thay đổi này cũng tăng `cart_version` và được gửi cho Agent như một sự kiện hệ thống ("ユーザーがカートを変更しました") để hội thoại nhất quán.
- Cảnh báo (`warnings`): "価格が変更されました", "売り切れ", "配達枠が過ぎました".

## 9.4 Màn hình xác nhận thanh toán

Modal toàn màn hình (mobile) / dialog (desktop), **render từ `GET /checkout/confirmation-requests/{id}`**, không từ text chat.

```
┌──────────────────────────────────────────────────────────┐
│  ご注文内容の確認                                    ✕    │
├──────────────────────────────────────────────────────────┤
│  ヘルシー食堂 渋谷店                                      │
│  ────────────────────────────────────────────────────── │
│  鶏むね肉と温野菜の蒸し定食 ※                   × 1       │
│    ご飯少なめ / 緑茶                            ¥1,340    │
│  クーポン LUNCH100 ※                           −¥100     │
│  配送料                                          ¥330     │
│  ────────────────────────────────────────────────────── │
│  8%対象   ¥1,240  （内消費税 ¥91）                         │
│  10%対象    ¥330  （内消費税 ¥30）                         │
│  ※は軽減税率（8%）対象                                     │
│  ────────────────────────────────────────────────────── │
│  合計（税込）                                  ¥1,570      │
│  獲得予定ポイント 15pt                                     │
│  ────────────────────────────────────────────────────── │
│  📅 お届け日時  2026年11月9日(月) 12:00〜12:30   [変更]    │
│  📍 お届け先    〒150-0002 東京都渋谷区渋谷2-21-1           │
│                渋谷ヒカリエ 20F                  [変更]    │
│  💳 お支払い    VISA **** 4242                  [変更]    │
│  🧾 領収書宛名  田中 健太 様                     [変更]    │
│  ⚠ アレルギー設定: えび・かに — 本注文の商品には含まれません  │
│  ────────────────────────────────────────────────────── │
│  ⏱ この確認画面の有効期限: 4:32                            │
│                                                          │
│  [ 内容を変更する ]        [ 🔒 確認して支払う  ¥1,570 ]   │
│                                                          │
│  「確認して支払う」を押すと、上記の金額で決済されます。        │
│  利用規約・キャンセルポリシー                               │
└──────────────────────────────────────────────────────────┘
```

**Hành vi bảo vệ**
- Nút chính hiển thị **số tiền** trên nút; chỉ bật sau khi summary tải xong và ≥ 1 giây (chống click nhầm/clickjacking); `frame-ancestors 'none'`.
- Bấm → nút chuyển "処理中…" và bị khóa; `Idempotency-Key` được sinh khi modal mở và dùng lại cho mọi lần retry.
- Có kết quả (thành công / thất bại / lỗi thời) → modal đóng và gửi `checkout_result` cho Agent → Claude báo mã đơn hoặc tự đề xuất phương án khác ngay trong chat.
- Nhận SSE `confirmation_invalidated` (khách vừa chat đổi món, giỏ đổi ở tab khác…) → modal hiển thị "内容が変更されました。最新の内容をご確認ください" và tải lại summary mới; nút cũ vô hiệu.
- Hết hạn (5 phút) → nút "再確認する" gọi lại `prepare_checkout` qua Agent.
- PayPay / 3-D Secure: mở redirect/app switch; quay lại trang `/checkout/return?payment_id=…` poll trạng thái rồi đóng modal.
- `[変更]` đóng modal và gửi `ui-action` tương ứng cho Agent ("お届け時間を変更したい").

## 9.5 Màn hình "私の好み / Sở thích của tôi"

```
アレルギー（必ず除外されます）  [えび ✕] [かに ✕]  [+ 追加]
食事制限                       なし ▾
よく注文するもの                鶏むね肉と温野菜の蒸し定食  ●●●●○  [理由] [削除]
好みではないもの                麻婆豆腐（辛すぎ）            [削除]
味の傾向                       辛さ ◀──●──────▶  油 ◀─●───────▶
パーソナライズ                  [ON]
[ すべての好みデータを削除 ]   [ データをダウンロード ]
```
`[理由]` mở danh sách `preference_events` giải thích nguồn gốc ("11/6 注文", "★5 評価").
