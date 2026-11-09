import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useApiFetch } from "../api/client";
import { useCart } from "../cart";
import { useCatalog } from "../catalog";
import { useAgentStream, type ItemCardData, type OrderReceipt, type TranscriptMessage } from "../hooks/useAgentStream";
import { CheckoutConfirmation } from "./CheckoutConfirmation";
import { allergenLabel } from "../labels";
import { menuPhoto } from "../photos";

const t = {
  ja: {
    title: "ご注文アシスタント",
    placeholder: "メッセージを入力…（例: 軽めで1,500円以下）",
    send: "送信",
    disclaimer: "AIが提案します。お支払いは確認画面のボタンでのみ行われます。",
    retry: "もう一度試す",
    choose: "これにする",
    cart: "カート",
    review: "内容を確認する",
    allergens: "アレルゲン",
    thinking: "考え中",
    working: {
      search_menu: "メニューを検索中", check_inventory: "在庫を確認中", check_delivery_slot: "配達枠を確認中", validate_address: "住所を確認中",
      get_item_detail: "メニューの詳細を確認中", add_to_cart: "カートに追加中", update_cart: "カートを更新中", get_cart: "カートを確認中",
      apply_coupon: "クーポンを確認中", prepare_checkout: "お会計を計算中", request_payment_confirmation: "確認画面を準備中",
      get_preferences: "お好みを確認中", get_user_profile: "お客様情報を確認中", update_preferences: "お好みを記録中",
    } as Record<string, string>,
  },
  en: {
    title: "Ordering assistant",
    placeholder: "Type a message… (e.g. something light under ¥1,500)",
    send: "Send",
    disclaimer: "Suggestions by AI. Payment only happens via the button on the confirmation screen.",
    retry: "Try again",
    choose: "Choose this",
    cart: "Cart",
    review: "Review order",
    allergens: "Allergens",
    thinking: "Thinking",
    working: {
      search_menu: "Searching the menu", check_inventory: "Checking stock", check_delivery_slot: "Checking delivery slots", validate_address: "Checking the address",
      get_item_detail: "Checking dish details", add_to_cart: "Adding to cart", update_cart: "Updating the cart", get_cart: "Checking the cart",
      apply_coupon: "Checking coupons", prepare_checkout: "Calculating the total", request_payment_confirmation: "Preparing the confirmation",
      get_preferences: "Checking your preferences", get_user_profile: "Checking your profile", update_preferences: "Saving your preference",
    } as Record<string, string>,
  },
};

/** Labels for server-provided match reason codes — never free text from the model. */
const REASONS: Record<string, { ja: string; en: string }> = {
  previously_liked: { ja: "以前高評価", en: "You rated it highly" },
  favorite_restaurant: { ja: "お気に入りの店", en: "Favorite restaurant" },
  within_budget: { ja: "予算内", en: "Within budget" },
  usual_price_range: { ja: "いつもの価格帯", en: "Your usual price" },
  low_oil_tag: { ja: "油控えめ", en: "Low oil" },
  light_tag: { ja: "軽め", en: "Light" },
};



const stripUntrusted = (s: string) => s.replace(/<\/?untrusted_data>/g, "");

/**
 * resumeSessionId: reopen a stored conversation (chat history) and continue it.
 * initialMessage : start a new conversation with this request instead of the greeting (from the home page).
 * orderItemId    : "Order" pressed on a home-page card — the item goes straight into the cart and the agent asks
 *                  only for the delivery time and address.
 */
export function AgentChat({
  locale = "ja",
  resumeSessionId,
  initialMessage,
  orderItemId,
  onNewChat,
  onSessionReady,
  onResumeFailed,
}: {
  locale?: "ja" | "en";
  resumeSessionId?: string;
  initialMessage?: string;
  orderItemId?: string;
  onNewChat?: () => void;
  /** The conversation's id once known (kept in the URL so a reload reopens it). */
  onSessionReady?: (sessionId: string) => void;
  /** resumeSessionId could not be loaded. */
  onResumeFailed?: () => void;
}) {
  const L = t[locale];
  const catalog = useCatalog();
  const sharedCart = useCart();
  const apiFetch = useApiFetch();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const chat = useAgentStream(sessionId);
  const started = useRef(false);
  const creating = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);
  const [startError, setStartError] = useState(false);

  // Create the session once (StrictMode runs effects twice in dev), then send an empty first message →
  // the agent greets using the customer's history.
  useEffect(() => {
    if (creating.current) return;
    creating.current = true;
    (async () => {
      if (resumeSessionId) {
        const t = await apiFetch(`/api/agent/sessions/${resumeSessionId}/transcript`);
        // Gone, or another account's conversation (e.g. remembered from before a sign-out): start a new chat instead.
        if (!t.ok) return onResumeFailed ? onResumeFailed() : setStartError(true);
        const { messages } = (await t.json()) as { messages: TranscriptMessage[] };
        chat.hydrate(messages, locale);
        started.current = true; // no greeting when continuing a conversation
        setSessionId(resumeSessionId);
        return;
      }
      const res = await apiFetch("/api/agent/sessions", { method: "POST", body: JSON.stringify({ locale }) });
      if (!res.ok) return setStartError(true);
      const { session_id } = (await res.json()) as { session_id: string };
      setSessionId(session_id);
    })().catch(() => setStartError(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiFetch, locale, resumeSessionId]);
  useEffect(() => {
    if (sessionId && !started.current) {
      started.current = true;
      if (orderItemId) {
        const name = catalog.itemName(orderItemId, orderItemId);
        void chat.orderItem(orderItemId, locale === "ja" ? `「${name}」を注文` : `Order "${name}"`);
      } else {
        void chat.send(initialMessage?.trim() ?? "");
      }
    }
  }, [sessionId, chat, initialMessage, orderItemId, catalog, locale]);
  useEffect(() => {
    if (sessionId) onSessionReady?.(sessionId);
  }, [sessionId, onSessionReady]);

  // The chat's cart (agent's cart_updated events, cleared after an order) feeds the shared cart: menu badge + cart screen.
  const firstCart = useRef(true);
  useEffect(() => {
    if (firstCart.current) {
      firstCart.current = false;
      return;
    }
    sharedCart.setCart(chat.cart);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.cart]);
  // An edit on the cart screen invalidated the open payment confirmation on the server: close it here too.
  const firstEdit = useRef(sharedCart.uiEdits);
  useEffect(() => {
    if (sharedCart.uiEdits !== firstEdit.current && chat.confirmationRequestId) chat.closeConfirmation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedCart.uiEdits]);

  // Block body on purpose: recent Chrome versions return a Promise from scrollIntoView(), and an effect must not
  // return anything but a cleanup function.
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat.entries.length, chat.toolStatus, chat.streaming]);

  const lastAssistant = [...chat.entries].reverse().find((e) => e.kind === "assistant");
  const lastAssistantHasText = !!(lastAssistant && lastAssistant.kind === "assistant" && lastAssistant.text);

  const submit = () => {
    const text = input.trim();
    if (!text || chat.streaming) return;
    setInput("");
    void chat.send(text);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Do not send while a Japanese IME composition is in progress.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="agent-layout">
      <section className="chat" aria-label={L.title}>
        <div className="chat__toolbar">
          <span className="muted small">{resumeSessionId ? (locale === "ja" ? "過去の会話を表示中" : "Viewing a past conversation") : L.title}</span>
          {onNewChat && <button type="button" onClick={onNewChat} disabled={chat.streaming}>＋ {locale === "ja" ? "新しい会話" : "New chat"}</button>}
        </div>

        <div className="chat__log" aria-live="polite">
          {chat.entries.map((e) => {
            switch (e.kind) {
              case "user":
                return <p key={e.id} className="bubble bubble--user">{e.text}</p>;
              case "note":
                return <p key={e.id} className="chat-note">{e.text}</p>;
              case "receipt":
                return <ReceiptCard key={e.id} receipt={e.receipt} locale={locale} />;
              case "assistant":
                return e.text ? <p key={e.id} className="bubble bubble--agent">{e.text}</p> : null;
              case "quick_replies":
                return (
                  <div key={e.id} className="chips">
                    {e.options.map((o) => (
                      <button key={o.id} type="button" onClick={() => chat.send(o.label)} disabled={chat.streaming}>{o.label}</button>
                    ))}
                  </div>
                );
              case "cards":
                return (
                  <div key={e.id} className="cards" role="list">
                    {e.items.map((item) => (
                      <ItemCard key={item.item_id} item={item} locale={locale} inCart={!!sharedCart.cart?.lines.some((l) => l.item.id === item.item_id)}
                        onChoose={() => {
                          const jaName = stripUntrusted(item.name);
                          const shown = catalog.itemName(item.item_id, jaName);
                          void chat.send(locale === "ja" ? `「${jaName}」にします` : shown === jaName ? `I'll take "${jaName}"` : `I'll take "${shown}" (${jaName})`);
                        }}
                        label={L.choose} allergenLabel={L.allergens} />
                    ))}
                  </div>
                );
            }
          })}
          {/* Shown from the moment a message is sent until the reply starts streaming, and while tools run. */}
          {chat.streaming && (chat.toolStatus || !lastAssistantHasText) && (
            <div className="bubble bubble--agent thinking" role="status" aria-live="polite">
              <span className="thinking__dots" aria-hidden><i /><i /><i /></span>
              <span>{chat.toolStatus ? L.working[chat.toolStatus] ?? L.thinking : L.thinking}…</span>
            </div>
          )}
          {chat.error && (
            <p role="alert" className="error">
              {chat.error.message ?? (locale === "ja" ? "申し訳ございません。一時的に応答できません。" : "Sorry, the assistant is unavailable.")}{" "}
              {chat.lastFailed && <button type="button" onClick={chat.retry} disabled={chat.streaming}>{L.retry}</button>}
            </p>
          )}
          {chat.handoffSuggested && (
            <p className="handoff">
              {locale === "ja" ? "お困りの点はカスタマーサポートでも承ります。" : "Our support team can also help with this."}
            </p>
          )}
          {startError && <p role="alert" className="error">{locale === "ja" ? "チャットを開始できませんでした。ページを再読み込みしてください。" : "Could not start the chat. Please reload the page."}</p>}
          <div ref={bottom} />
        </div>

        <div className="chat__input">
          <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={onKeyDown} placeholder={L.placeholder} rows={2} maxLength={2000} />
          <button type="button" onClick={submit} disabled={chat.streaming || !input.trim()}>{L.send}</button>
          <small>{L.disclaimer}</small>
        </div>
      </section>

      <aside className="mini-cart" aria-label={L.cart}>
        <h2>🛒 {L.cart}</h2>
        {sharedCart.cart?.lines.map((l) => (
          <div key={l.id} className="mini-cart__line">
            <span>{catalog.itemName(l.item.id, stripUntrusted(l.item.name))} × {l.quantity}</span>
            <span>{catalog.money(l.lineTotal)}</span>
          </div>
        ))}
        {sharedCart.cart && sharedCart.cart.lines.length > 0 && <p className="mini-cart__subtotal">{catalog.money(sharedCart.cart.subtotal)}</p>}
      </aside>

      {chat.confirmationRequestId && (
        <CheckoutConfirmation
          confirmationRequestId={chat.confirmationRequestId}
          locale={locale}
          onClose={chat.closeConfirmation}
          onResult={(id) => {
            chat.closeConfirmation();
            void chat.reportCheckout(id); // the agent confirms in chat (order number) or re-plans on failure
          }}
          onChangeRequested={(what) => {
            chat.closeConfirmation();
            void chat.send(locale === "ja" ? `${what}を変更したいです` : `I want to change the ${what}`);
          }}
        />
      )}
    </div>
  );
}

function ItemCard(props: { item: ItemCardData; locale: "ja" | "en"; inCart: boolean; onChoose: () => void; label: string; allergenLabel: string }) {
  const { item, locale } = props;
  const catalog = useCatalog();
  const reasons = item.match_reasons.map((r) => REASONS[r]?.[locale]).filter(Boolean).join(" · ");
  return (
    <article className="item-card" role="listitem">
      <img src={item.image_url ?? menuPhoto(item.item_id)} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.display = "none")} />
      <h3>{catalog.itemName(item.item_id, stripUntrusted(item.name))}</h3>
      <p className="item-card__meta">{catalog.restaurantOf(item.item_id, stripUntrusted(item.restaurant.name))}{item.calories ? ` · ${item.calories}kcal` : ""}</p>
      <p className="item-card__price">{catalog.money(item.price_incl_tax)}{locale === "ja" ? "（税込）" : " (tax incl.)"}</p>
      {reasons && <p className="item-card__reasons">💡 {reasons}</p>}
      <p className="item-card__allergens">
        {props.allergenLabel}: {item.allergens.map((a) => allergenLabel(a, locale)).join(" · ") || "—"}
      </p>
      {props.inCart ? <span className="badge">✅ {locale === "ja" ? "カートに追加済" : "In cart"}</span> : <button type="button" onClick={props.onChoose}>{props.label}</button>}
    </article>
  );
}

/** Order details after payment: the same content as the confirmation email, from the server's order snapshot. */
function ReceiptCard({ receipt: r, locale }: { receipt: OrderReceipt; locale: "ja" | "en" }) {
  const ja = locale === "ja";
  const { lineLabel, money: yen } = useCatalog();
  const time = (iso: string) => iso.slice(11, 16);
  const date = new Date(r.delivery_slot.start).toLocaleDateString(ja ? "ja-JP" : "en-US", { timeZone: "Asia/Tokyo", month: "long", day: "numeric", weekday: "short" });
  return (
    <article className="receipt" aria-label={ja ? "ご注文内容" : "Order details"}>
      <header>
        <strong>✅ {ja ? "ご注文が完了しました" : "Order placed"}</strong>
        <span className="muted small">{ja ? "注文番号" : "Order no."} {r.order_id}</span>
      </header>
      <table className="summary">
        <tbody>
          {r.lines.map((l, i) => (
            <tr key={`l${i}`}><td>{lineLabel(l)}{l.taxRate === 8 ? " ※" : ""} × {l.quantity}</td><td>{yen(l.amount)}</td></tr>
          ))}
          {r.discounts.map((d, i) => (
            <tr key={`d${i}`}><td>{lineLabel(d)}{d.taxRate === 8 ? " ※" : ""}</td><td>−{yen(Math.abs(d.amount))}</td></tr>
          ))}
          <tr><td>{ja ? "配送料" : "Delivery fee"}</td><td>{yen(r.delivery_fee)}</td></tr>
        </tbody>
      </table>
      <ul className="tax-breakdown">
        {r.tax_breakdown.map((b) => (
          <li key={b.rate}>{ja ? `${b.rate}%対象 ${yen(b.taxableAmountInclTax)}（内消費税 ${yen(b.tax)}）` : `${b.rate}% items ${yen(b.taxableAmountInclTax)} (incl. tax ${yen(b.tax)})`}</li>
        ))}
      </ul>
      <p className="summary__total">{ja ? "お支払い金額（税込）" : "Total paid (tax incl.)"} <strong>{yen(r.total)}</strong></p>      <dl className="summary__details">
        <dt>📅</dt><dd>{date} {time(r.delivery_slot.start)}〜{time(r.delivery_slot.end)}</dd>
        <dt>📍</dt><dd>{r.address_text}</dd>
        <dt>💳</dt><dd>{r.payment_label}</dd>
      </dl>
      {r.email && <p className="receipt__mail">📧 {ja ? `この内容を ${r.email} にお送りしました（領収書付き）` : `These details were sent to ${r.email} (invoice attached)`}</p>}
    </article>
  );
}
