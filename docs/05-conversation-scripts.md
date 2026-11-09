# 5. Kịch bản hội thoại mẫu

Ký hiệu: 🤖 Agent (Claude Haiku 5.5) · 👤 Khách · `⚙` tool call do Claude quyết định (không hiển thị cho khách) · `🧠` tóm tắt suy nghĩ/kế hoạch của Claude (ghi vào audit log, không hiển thị) · `🪶` tác vụ nhẹ chạy riêng (cũng Claude Haiku 5.5) · 🖥 sự kiện UI.
Mỗi câu tiếng Nhật kèm bản dịch tiếng Việt (*in nghiêng*).

Khách hàng mẫu: **田中 健太 (Tanaka Kenta)** — đăng nhập qua Entra ID. Hồ sơ:
- Địa chỉ đã lưu: 会社 `〒150-0002 東京都渋谷区渋谷2-21-1 渋谷ヒカリエ 20F`, 自宅 `〒154-0004 東京都世田谷区太子堂4-1-1 キャロットタワー 1203`
- Thói quen: đặt trưa thứ 2–6, giao 12:00 đến văn phòng Shibuya, ngân sách thường ¥1,000–1,500
- Dị ứng (khai báo): **えび (tôm), かに (cua)** — ràng buộc cứng
- Đánh giá cao: 鶏むね肉の蒸し定食 (★5), 鮭の塩焼き弁当 (★4). Đánh giá thấp: 麻婆豆腐 (★2 – "辛すぎ / cay quá")
- PTTT mặc định: Visa ****4242; có PayPay đã liên kết

---

## 5.1 Luồng thành công

> 🤖 田中様、こんにちは。今日もいつものように、渋谷ヒカリエのオフィスへ12:00にお届けでよろしいでしょうか？
> *Chào anh Tanaka. Hôm nay vẫn giao đến văn phòng Shibuya Hikarie lúc 12:00 như mọi khi chứ ạ?*
>
> 🖥 Nút gợi ý nhanh: `[はい、いつも通り]` `[時間を変える]` `[住所を変える]`

`customer_context` (profile + tóm tắt sở thích + giỏ dở dang: không có) được backend đưa vào lượt đầu, nên Claude không cần gọi `get_user_profile` / `get_preferences`.
`🧠 Thói quen: thứ 2–6, 12:00, văn phòng, độ tin cậy 0.86 → đề xuất luôn trong 1 câu hỏi.`

> 👤 はい、いつも通りで。
> *Vâng, như mọi khi.*

`🪶 classify_intent → order_flow`
`🧠 Giờ + địa chỉ đã chốt; kiểm tra slot và vùng giao song song, rồi hỏi khẩu vị.`
`⚙ check_delivery_slot {date:"2026-11-09", slot_start:"12:00"} → available, order_cutoff 10:30, now 09:52`
`⚙ validate_address {address_id:"addr_office"} → in_area, zone "SHIBUYA-A", fee ¥330`

> 🤖 承知いたしました。本日12:00〜12:30のお届け枠は空いております（ご注文締切は10:30です）。
> 今日はどのようなものを召し上がりたいですか？
> *Đã rõ. Khung 12:00–12:30 hôm nay vẫn còn chỗ (hạn chót đặt là 10:30). Hôm nay anh muốn ăn gì ạ?*
>
> 🖥 Chip: `[軽め]` `[がっつり]` `[温かい]` `[冷たい]` `[ご飯]` `[麺]` `[¥1,000以下]` `[2人以上]`

> 👤 軽めで油っこくないもの。1,500円以下でお願いします。
> *Món gì nhẹ nhàng, không nhiều dầu mỡ. Dưới 1.500 yên nhé.*

`🧠 "軽め・油少なめ・¥1,500以下" → taste_tags light + low_oil, max_price 1500; dị ứng えび・かに backend tự thêm.`
`⚙ search_menu {query:"ヘルシー 蒸し 和食 あっさり", filters:{max_price:1500, exclude_allergens:["shrimp","crab"], taste_tags_any:["light","low_oil"], delivery_slot:"2026-11-09T12:00+09:00", area:"SHIBUYA-A"}, limit:20}`
→ Server ép thêm `NOT allergens:shrimp AND NOT allergens:crab` và rerank. Trả về top 5 (đã làm sạch mô tả).

> 🤖 田中様のお好みと今日のご希望から、3つ選びました。
>
> 1. **鶏むね肉と温野菜の蒸し定食**（ヘルシー食堂 渋谷店）¥1,180 — 以前★5をつけていただいたメニューです。蒸し調理で油控えめです。
> 2. **鮭の塩焼きと五穀米の弁当**（和ごはん 結）¥1,250 — 塩焼きで脂っこくなく、★4の評価をいただいています。
> 3. **豆腐ときのこのあんかけ丼**（ヘルシー食堂 渋谷店）¥980 — 初めてのメニューですが、えび・かにを使用しておらず、あっさりした味付けです。
>
> いつもの1番をカートに入れておきますね。他のものがよろしければお知らせください。
>
> *Dựa trên sở thích của anh và yêu cầu hôm nay, em chọn 3 món:*
> *1. Set gà ức hấp rau củ (Healthy Shokudo Shibuya) ¥1.180 — món anh từng chấm 5★, hấp nên ít dầu.*
> *2. Cơm hộp cá hồi nướng muối + cơm ngũ cốc (Wa-gohan Yui) ¥1.250 — nướng muối nên không ngấy, anh từng chấm 4★.*
> *3. Cơm đậu phụ nấm sốt sệt (Healthy Shokudo) ¥980 — món mới, không dùng tôm/cua, vị thanh.*
> *Em cho món số 1 quen thuộc vào giỏ nhé. Nếu muốn món khác anh cứ nói ạ.*

`⚙ get_item_detail {item_id:"itm_1021"} → options: ご飯の量 [普通, 少なめ, 大盛り +¥100], ドリンク [なし, 緑茶 +¥160]`
`⚙ add_to_cart {item_id:"itm_1021", quantity:1, options:{rice:"normal", drink:"none"}} → cart v1`

> 🤖 カートに追加しました。ご飯の量は「普通」でよろしいですか？お飲み物（緑茶 +¥160）もお付けできます。
> *Đã thêm vào giỏ. Lượng cơm "bình thường" được không ạ? Có thể thêm trà xanh (+¥160).*

> 👤 ご飯少なめで、緑茶もつけて。
> *Cơm ít thôi, thêm trà xanh.*

`⚙ update_cart {cart_line_id:"ln_1", options:{rice:"less", drink:"green_tea"}} → cart v2, line ¥1,340`
`⚙ apply_coupon {auto:true} → áp "LUNCH100" (−¥100, 1 lần/ngày, đơn ≥ ¥1,000)`
`⚙ prepare_checkout {} → summary (cart_version 3)`
`⚙ request_payment_confirmation {} → confirmation_request_id "cr_8f2…", hiển thị màn hình xác nhận`

> 🤖 ご飯少なめ・緑茶付きに変更し、クーポン「LUNCH100」（100円引き）を適用しました。
> 内容をご確認のうえ、画面の「確認して支払う」ボタンを押してください。
> *Đã đổi sang cơm ít + trà xanh và áp mã LUNCH100 (giảm 100 yên). Anh kiểm tra nội dung và bấm nút "Xác nhận & Thanh toán" trên màn hình nhé.*

🖥 **Màn hình xác nhận** (xem wireframe ở [09](09-ui-wireframes.md#94-màn-hình-xác-nhận-thanh-toán)):

| 項目 | 金額 |
|---|---|
| 鶏むね肉と温野菜の蒸し定食（ご飯少なめ・緑茶付き） × 1 ※ | ¥1,340 |
| クーポン LUNCH100 ※ | −¥100 |
| 配送料 | ¥330 |
| **合計（税込）** | **¥1,570** |
| 8%対象 ¥1,240（内消費税 ¥91） / 10%対象 ¥330（内消費税 ¥30） | |
| ※は軽減税率(8%)対象 | |
| お届け: 2026/11/09(月) 12:00–12:30 · 〒150-0002 東京都渋谷区渋谷2-21-1 渋谷ヒカリエ 20F | |
| お支払い: VISA **** 4242 | |

> 👤 🖥 *(bấm nút「確認して支払う」)*

`POST /checkout/confirm → token → execute_payment → PSP OK → order A-20261109-0042 → enqueue invoice/email/preferences`

> 🤖 ご注文が確定しました。ありがとうございます！
> 注文番号: **A-20261109-0042** / お届け予定: 12:00〜12:30
> 領収書（適格請求書）を添付した確認メールを kenta.tanaka@example.co.jp にお送りしました。
> *Đơn hàng đã được xác nhận. Cảm ơn anh! Mã đơn: A-20261109-0042, giao 12:00–12:30. Email xác nhận kèm hóa đơn hợp lệ đã gửi tới kenta.tanaka@example.co.jp.*

*(12:45 — sau giờ giao)*

> 🤖 田中様、本日の「鶏むね肉と温野菜の蒸し定食」はいかがでしたか？ `[★1]…[★5]` `[コメント]`
> *Món set gà hấp hôm nay thế nào ạ?*
>
> 👤 ★4。ちょっと味が薄かったかな。
> *4 sao. Hơi nhạt một chút.*

`POST /api/agent/feedback → 🪶 extract_preference_signals (structured output) → {kind:"taste", dimension:"saltiness", direction:"+", strength:0.4, evidence:"ちょっと味が薄かった"} + rating ★4 → preference_events`

> 🤖 ご評価ありがとうございます。次回からは、もう少ししっかりした味付けのメニューも候補に入れますね。
> *Cảm ơn anh. Lần sau em sẽ gợi ý thêm các món đậm vị hơn một chút.*

---

## 5.2 Luồng lỗi 1 — Hết món + khung giờ đầy

> 🤖 田中様、こんにちは。今日も渋谷ヒカリエのオフィスへ12:00にお届けでよろしいでしょうか？
> *Chào anh Tanaka. Hôm nay vẫn giao văn phòng Shibuya Hikarie lúc 12:00 chứ ạ?*
>
> 👤 うん。いつもの鶏の蒸し定食で。
> *Ừ. Set gà hấp như mọi khi.*

`⚙ check_delivery_slot {slot_start:"12:00"} → status:"full", alternatives:["11:30","12:30","13:00"]`

> 🤖 申し訳ございません。本日12:00〜12:30の枠は満席となっております。
> 11:30、12:30、13:00の枠でしたらお届け可能です。いかがでしょうか？
> *Rất xin lỗi, khung 12:00–12:30 hôm nay đã kín. Khung 11:30, 12:30, 13:00 vẫn còn. Anh chọn khung nào ạ?*
>
> 🖥 Chip: `[11:30]` `[12:30]` `[13:00]`
>
> 👤 12:30で。
> *12:30.*

`⚙ check_delivery_slot {slot_start:"12:30"} → available`
`⚙ check_inventory {items:[{item_id:"itm_1021", quantity:1}], date:"2026-11-09", slot_start:"12:30"} → available:false, reason:"SOLD_OUT"`
`🧠 Món quen đã hết → tự lập lại kế hoạch: tìm món hấp cùng quán hoặc món khách từng chấm cao, giữ nguyên 12:30 + văn phòng.`
`⚙ search_menu {query:"蒸し 鶏 定食", filters:{restaurant_id:"rst_healthy_shibuya", taste_tags_any:["low_oil"]}, …} + check_inventory → 2 món còn hàng`

> 🤖 12:30で承りました。ただ、あいにく「鶏むね肉と温野菜の蒸し定食」は本日売り切れとなっております。
> 似たメニューとして、次の2つはいかがでしょうか。
> 1. **蒸し鶏とブロッコリーの雑穀ごはんプレート** ¥1,150 — 同じお店の、蒸し調理のメニューです。
> 2. **鮭の塩焼きと五穀米の弁当** ¥1,250 — 以前★4をつけていただきました。
>
> *Đã nhận khung 12:30. Tuy nhiên set gà hấp hôm nay đã hết. Món tương tự: (1) Đĩa gà hấp bông cải + cơm ngũ cốc ¥1.150 — cùng quán, cũng hấp. (2) Cơm hộp cá hồi nướng muối ¥1.250 — anh từng chấm 4★.*
>
> 👤 1で。
> *Món 1.*

`⚙ add_to_cart {item_id:"itm_1033", quantity:1} → cart v1`
`⚙ prepare_checkout → request_payment_confirmation`

> 🤖 カートに追加しました。内容をご確認のうえ「確認して支払う」を押してください。
> *Đã thêm vào giỏ. Anh kiểm tra và bấm "Xác nhận & Thanh toán" nhé.*

🖥 *Khách mở màn hình xác nhận nhưng chưa bấm. Trong 2 phút đó, quán báo món `itm_1033` cũng hết.*

> 👤 🖥 *(bấm「確認して支払う」)*

`POST /checkout/confirm → Commerce API kiểm tra lại tồn kho → execute_payment trả lỗi ITEM_SOLD_OUT → không trừ tiền, không tạo đơn; UI gửi checkout_result → system message checkout_failed {code: ITEM_SOLD_OUT, charged:false}`
`🧠 Thanh toán chưa xảy ra; món phụ hết. Phương án gần nhất còn lại: cá hồi nướng (★4), kiểm tra tồn rồi đề xuất.`
`⚙ check_inventory {items:[{item_id:"itm_0877", quantity:1}], …} → available`

> 🤖 大変申し訳ございません。お支払いの直前に「蒸し鶏とブロッコリーの雑穀ごはんプレート」が売り切れになりました。**お支払いは行われていません。**
> 代わりに「鮭の塩焼きと五穀米の弁当」（¥1,250）はいかがでしょうか？
> *Rất xin lỗi, ngay trước khi thanh toán thì món đĩa gà hấp đã hết. **Chưa có khoản tiền nào bị trừ.** Anh dùng cơm hộp cá hồi (¥1.250) thay thế nhé?*
>
> 👤 じゃあそれで。
> *Vậy lấy món đó.*

`⚙ update_cart {remove: ln_1, add: itm_0877} → cart v3 → prepare_checkout → request_payment_confirmation (token cũ vô hiệu vì cart_version đổi)`

> 🤖 変更しました。新しい内容で確認画面を表示しています。
> *Đã đổi. Màn hình xác nhận với nội dung mới đang hiển thị.*

🖥 *(Khách bấm xác nhận → thành công như 4.1)*

---

## 5.3 Luồng lỗi 2 — Địa chỉ ngoài vùng giao + thanh toán thất bại

> 🤖 田中様、こんにちは。今日も渋谷ヒカリエのオフィスへ12:00でよろしいですか？
> *Chào anh Tanaka. Hôm nay vẫn giao văn phòng Shibuya lúc 12:00 chứ ạ?*
>
> 👤 今日は横浜の客先にいるので、〒220-0012 横浜市西区みなとみらい3-3-1 三菱重工横浜ビル 5F に届けてほしい。
> *Hôm nay tôi ở chỗ khách hàng ở Yokohama, giao đến 〒220-0012 横浜市西区みなとみらい3-3-1 三菱重工横浜ビル 5F nhé.*

`🧠 Địa chỉ mới, chưa lưu → chuẩn hóa + kiểm tra vùng trước khi làm gì khác.`
`⚙ validate_address {address:{postal_code:"220-0012", prefecture:"神奈川県", city:"横浜市西区", street:"みなとみらい3-3-1", building:"三菱重工横浜ビル 5F"}}`
→ `normalized: 神奈川県横浜市西区みなとみらい3-3-1 …` · `in_area:false` · `nearest_area:"SHIBUYA-A"` · `reason:"OUT_OF_SERVICE_AREA"`

> 🤖 ご住所を確認いたしました（神奈川県横浜市西区みなとみらい3-3-1 三菱重工横浜ビル 5F）。
> 申し訳ございません、現在このエリアはお届け対象外です。現在は東京23区内の一部エリアのみ対応しております。
> 次のいずれかでいかがでしょうか？
> - 登録済みのご自宅（世田谷区太子堂）へ夕食としてお届け
> - 対象エリアの別のご住所を入力
>
> *Em đã kiểm tra địa chỉ (… Yokohama). Rất tiếc khu vực này hiện chưa nằm trong vùng giao (hiện chỉ phục vụ một số khu trong 23 quận Tokyo). Anh muốn: giao bữa tối về nhà (Taishido, Setagaya), hay nhập địa chỉ khác trong vùng giao?*
>
> 👤 じゃあ自宅に19:00で。2人分、温かい麺がいいな。
> *Vậy giao về nhà lúc 19:00. 2 người, muốn mì nóng.*

`⚙ validate_address {address_id:"addr_home"} → in_area, zone "SETAGAYA-B", fee ¥380`
`⚙ check_delivery_slot {date:"2026-11-09", slot_start:"19:00", address_id:"addr_home"} → available`
`⚙ search_menu {query:"温かい 麺 うどん そば ラーメン", filters:{exclude_allergens:["shrimp","crab"], category:"noodles", serving_temp:"hot", max_price:1500, …}}`
→ Server loại các món chứa えび/かに (ví dụ 天ぷらうどん có tôm). **Lưu ý**: soba chứa そば — không phải dị ứng của khách nên được giữ.

> 🤖 ご自宅へ19:00〜19:30でお届けできます。温かい麺を2人分ですね。
> 1. **鶏と九条ねぎの温うどん** ¥980 × 2 — えび・かには使用していません。
> 2. **醤油ラーメン（チャーシュー）** ¥1,050 × 2
>
> 1番を2つカートに入れておきますね。
> *Có thể giao về nhà 19:00–19:30. Mì nóng cho 2 người: (1) Udon nóng gà + hành Kujo ¥980 × 2 — không dùng tôm/cua. (2) Ramen xì dầu (chashu) ¥1.050 × 2. Em cho 2 phần món 1 vào giỏ nhé.*

`⚙ add_to_cart {item_id:"itm_2210", quantity:2} → prepare_checkout → request_payment_confirmation`

> 👤 支払いはPayPayにして。
> *Thanh toán bằng PayPay nhé.*

`⚙ prepare_checkout {payment_method_id:"pm_paypay"} → cart_version không đổi nhưng checkout_hash đổi → confirmation_request cũ bị hủy, tạo mới`

> 🤖 お支払い方法をPayPayに変更しました。確認画面をご確認ください。
> *Đã đổi phương thức sang PayPay. Anh kiểm tra màn hình xác nhận nhé.*

> 👤 🖥 *(bấm「確認して支払う」→ chuyển sang app PayPay → số dư không đủ / từ chối)*

`PSP webhook → payment FAILED (code: INSUFFICIENT_BALANCE) → create_order không chạy; giỏ giữ nguyên; idempotency key cũ ghi nhận kết quả FAILED (lần thử tiếp theo là màn hình xác nhận mới với key mới)`
`system message: checkout_failed {code:"INSUFFICIENT_BALANCE", charged:false}`
`🧠 Không bị trừ tiền; còn thẻ VISA đã lưu → đề xuất đổi PTTT, giữ nguyên giỏ/giờ/địa chỉ.`

> 🤖 PayPayでのお支払いが完了しませんでした（残高不足のため）。**ご請求は発生していません。**
> カートはそのまま保存しています。登録済みのVISA（**** 4242）でお支払いされますか？
> *Thanh toán PayPay không thành công (không đủ số dư). **Không có khoản phí nào bị tính.** Giỏ hàng vẫn được giữ nguyên. Anh có muốn thanh toán bằng thẻ VISA (****4242) đã lưu không?*
>
> 🖥 Chip: `[VISA ****4242で支払う]` `[PayPayにチャージして再試行]` `[後で]`
>
> 👤 VISAで。
> *Dùng VISA.*

`⚙ prepare_checkout {payment_method_id:"pm_card_4242"} → request_payment_confirmation (request mới)`

> 🤖 VISA（**** 4242）に変更しました。確認画面の「確認して支払う」を押してください。
> *Đã đổi sang VISA. Anh bấm "Xác nhận & Thanh toán" trên màn hình nhé.*
>
> 👤 🖥 *(bấm xác nhận → 3-D Secure → thành công)*
>
> 🤖 ご注文が確定しました。注文番号: **A-20261109-0187** / お届け: 19:00〜19:30（ご自宅）
> *Đơn hàng đã xác nhận. Mã đơn A-20261109-0187, giao 19:00–19:30 về nhà.*

---

## 5.4 Tổng hợp các nhánh lỗi

| Tình huống | Phát hiện ở đâu | Hành vi Agent / hệ thống | Tiền có bị trừ? |
|---|---|---|---|
| **Hết món** (lúc tìm) | `search_menu` lọc `is_sold_out`; `add_to_cart` kiểm lại | Không gợi ý món hết; nếu khách yêu cầu đích danh → xin lỗi + 2 món tương tự (cùng quán/cùng tag/đã đánh giá cao) | Không |
| **Hết món** (sau màn hình xác nhận) | Commerce API kiểm lại tồn kho trong `execute_payment` trước khi gọi PSP | Trả 409 `ITEM_SOLD_OUT`, hủy confirmation request, Agent đề xuất thay thế, tạo request mới | Không |
| **Khung giờ đầy / quá giờ đóng đơn / không đủ thời gian chuẩn bị** | `check_delivery_slot` (+ kiểm lại khi thanh toán, có **giữ chỗ slot 10 phút** khi mở màn hình xác nhận) | Đưa 3 khung gần nhất còn trống; nếu quá giờ đóng đơn trưa → đề xuất khung chiều/tối hoặc ngày mai | Không |
| **Địa chỉ ngoài vùng giao / không hợp lệ** | `validate_address` (chuẩn hóa 〒 → tỉnh/thành phố bằng dữ liệu mã bưu điện Japan Post, rồi đối chiếu polygon/vùng) | Đọc lại địa chỉ đã chuẩn hóa, nói rõ ngoài vùng, gợi ý địa chỉ đã lưu trong vùng hoặc nhập lại. Mã bưu điện không khớp tỉnh/thành → hỏi lại | Không |
| **Thanh toán thất bại** (từ chối thẻ, 3DS fail, PayPay không đủ số dư, timeout) | PSP trả lỗi / webhook | Giỏ giữ nguyên, nói rõ **không bị tính tiền**, gợi ý PTTT khác. Timeout không rõ kết quả → trạng thái `PENDING_CONFIRMATION`, không cho thanh toán lại cho đến khi đối soát xong với PSP (tránh trừ 2 lần) | Không (hoặc được void tự động) |
| **Khách bỏ dở giữa chừng** | Không có tin nhắn > 15 phút / đóng tab | Giỏ và trạng thái hội thoại lưu trong DB (giỏ) + Redis (hội thoại 24h; tóm tắt bằng Haiku lưu ở `chat_sessions` 7 ngày). Lần sau: "前回のカート（○○）が残っています。続けますか？ / Giỏ lần trước vẫn còn, tiếp tục chứ?" — kiểm tra lại tồn kho & giá trước khi khôi phục; slot đã qua thì hỏi lại giờ | Không |
| **Khách đổi ý sau khi đã ở màn hình xác nhận** | Khách chat "やっぱり…" hoặc bấm nút `[内容を変更 / Thay đổi]` | Màn hình xác nhận đóng/đánh dấu "lỗi thời"; mọi thay đổi giỏ làm tăng `cart_version` → confirmation request cũ **tự động vô hiệu**; Agent cập nhật và hiển thị màn hình xác nhận mới. Nếu khách bấm nút trên màn hình cũ → 409 `CONFIRMATION_STALE` | Không |
| **Khách chỉ gõ "thanh toán đi / 支払って"** | System prompt + thiết kế tool | Agent không thể thanh toán bằng chat; trả lời: "お支払いは画面の『確認して支払う』ボタンからお願いいたします。" | Không |
| **Món vi phạm dị ứng lọt vào giỏ** (ví dụ dữ liệu Algolia lệch) | `add_to_cart` kiểm lại allergens từ DB (nguồn sự thật) | Từ chối thêm, log sự cố mức cao, báo khách | Không |
| **Claude API lỗi / quá tải (429, 5xx, 529) / timeout** | `LLMProvider` | Retry tối đa 3 lần với exponential backoff + jitter (tôn trọng `retry-after`), chỉ khi chưa stream chữ nào tới khách. Hết retry → thông báo lịch sự bằng ngôn ngữ của khách: 「ただいまアシスタントが混み合っております。カートの内容は保存されています…」 + link màn hình đặt món thường. Giỏ, slot giữ chỗ và lịch sử hội thoại không mất; lần chat sau tiếp tục bình thường | Không |
| **Claude từ chối (refusal)** | `stop_reason: "refusal"` | Server-side fallback tự chạy lại một số loại; nếu vẫn từ chối → thông báo lịch sự + luồng thường, ghi audit | Không |
| **Vượt hạn mức chi phí/ngày của người dùng** | `budget.ts` | Không gọi Claude nữa trong ngày; giỏ giữ nguyên; khách tiếp tục bằng màn hình đặt món thường | Không |
| **Hội thoại quá dài** | Context Manager | 🪶 Haiku tóm tắt (giờ, địa chỉ, giỏ, dị ứng nhắc trong phiên, câu hỏi còn mở) → bắt đầu “epoch” mới từ bản tóm tắt; khách không nhận thấy | Không |
