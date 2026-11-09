import { useState } from "react";
import { useCart } from "../cart";
import { useCatalog } from "../catalog";
import { menuPhoto } from "../photos";

const MAX_QTY = 20;
const ERRORS: Record<string, { ja: string; en: string }> = {
  ITEM_SOLD_OUT: { ja: "在庫が足りません。数量を減らしてください。", en: "Not enough stock for that quantity." },
  CART_VERSION_CONFLICT: { ja: "カートが更新されていました。最新の内容を表示しています。", en: "Your cart was updated elsewhere. Showing the latest version." },
  LINE_NOT_FOUND: { ja: "この商品はすでにカートにありません。", en: "That item is no longer in your cart." },
};

/** Cart screen (menu cart icon): change quantities, remove dishes, then check out with the assistant. */
export function CartPanel({ locale, onContinueShopping, onCheckout }: {
  locale: "ja" | "en";
  onContinueShopping: () => void;
  onCheckout: () => void;
}) {
  const ja = locale === "ja";
  const { cart, setQuantity, removeLine } = useCart();
  const catalog = useCatalog();
  const [busyLine, setBusyLine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(lineId: string, action: () => ReturnType<typeof removeLine>) {
    setBusyLine(lineId);
    setError(null);
    const r = await action();
    setBusyLine(null);
    if (!r.ok) setError(ERRORS[r.code]?.[locale] ?? (ja ? "更新できませんでした。もう一度お試しください。" : "Could not update the cart. Please try again."));
  }

  const lines = cart?.lines ?? [];
  const optionText = (options?: Record<string, string>) =>
    Object.entries(options ?? {})
      .map(([g, c]) => {
        const group = catalog.optionName(g);
        const choice = catalog.optionName(`${g}.${c}`);
        return group && choice ? `${group}: ${choice}` : null;
      })
      .filter(Boolean)
      .join(ja ? "・" : ", ");

  return (
    <section className="panel cart-panel">
      <h2>{ja ? "カート" : "Your cart"}</h2>
      {error && <p role="alert" className="error">{error}</p>}

      {lines.length === 0 ? (
        <div className="cart-empty">
          <p className="muted">{ja ? "カートは空です。" : "Your cart is empty."}</p>
          <button type="button" className="primary" onClick={onContinueShopping}>{ja ? "メニューを見る" : "Browse the menu"}</button>
        </div>
      ) : (
        <>
          <ul className="cart-lines">
            {lines.map((l) => {
              const name = catalog.itemName(l.item.id, l.item.name);
              const busy = busyLine === l.id;
              const opts = optionText(l.options);
              return (
                <li key={l.id} className="cart-line" aria-busy={busy}>
                  <img src={menuPhoto(l.item.id)} alt="" className="cart-line__photo" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />
                  <div className="cart-line__info">
                    <strong>{name}</strong>
                    {opts && <span className="muted small">{opts}</span>}
                    {l.unitPriceInclTax !== undefined && <span className="muted small">{catalog.money(l.unitPriceInclTax)} {ja ? "／個" : "each"}</span>}
                  </div>
                  <div className="qty" role="group" aria-label={ja ? `${name} の数量` : `Quantity of ${name}`}>
                    <button type="button" aria-label={ja ? "1つ減らす" : "Decrease"} disabled={busy || l.quantity <= 1}
                      onClick={() => run(l.id, () => setQuantity(l.id, l.quantity - 1))}>−</button>
                    <span aria-live="polite">{l.quantity}</span>
                    <button type="button" aria-label={ja ? "1つ増やす" : "Increase"} disabled={busy || l.quantity >= MAX_QTY}
                      onClick={() => run(l.id, () => setQuantity(l.id, l.quantity + 1))}>＋</button>
                  </div>
                  <strong className="cart-line__total">{catalog.money(l.lineTotal)}</strong>
                  <button type="button" className="cart-line__remove" disabled={busy}
                    aria-label={ja ? `${name} を削除` : `Remove ${name}`} title={ja ? "削除" : "Remove"}
                    onClick={() => run(l.id, () => removeLine(l.id))}>
                    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
                    </svg>
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="cart-subtotal">
            {ja ? "小計（税込）" : "Subtotal (tax incl.)"} <strong>{catalog.money(cart!.subtotal)}</strong>
          </p>
          <p className="muted small cart-note">
            {ja ? "配送料・クーポンはお届け日時と住所を決めたあとに計算されます。" : "Delivery fee and coupons are calculated once the delivery time and address are set."}
          </p>
          <div className="cart-actions">
            <button type="button" onClick={onContinueShopping}>{ja ? "買い物を続ける" : "Continue shopping"}</button>
            <button type="button" className="primary" onClick={onCheckout}>{ja ? "AIで注文手続きへ" : "Check out with AI"}</button>
          </div>
        </>
      )}
    </section>
  );
}
