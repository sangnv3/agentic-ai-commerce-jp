import { useEffect, useRef, useState, type FormEvent } from "react";
import { useApiFetch } from "../api/client";
import { useCart } from "../cart";
import { useCatalog } from "../catalog";
import { allergenLabel, CATEGORIES, dietaryLabel, MANDATORY_ALLERGENS, TAGS } from "../labels";
import { categoryPhoto, menuPhoto } from "../photos";
import { HeroCarousel, type Slide } from "./HeroCarousel";
import { HowToOrder } from "./HowToOrder";

/** Why a dish conflicts with the customer's hard constraints. */
interface Block {
  allergens: string[];
  dietary: string[];
}

const EXAMPLES = {
  ja: ["サーモン寿司 1人前", "温かい麺 2人分", "えびなし天ぷら"],
  en: ["Salmon sushi for 1", "Hot noodles for 2", "Tempura, no shrimp"],
};

/** Home: menu by category + entry points into the AI ordering chat. */
export function HomePage({ locale, onAskAgent, onOrderItem, onOpenPreferences }: {
  locale: "ja" | "en";
  onAskAgent: (message?: string) => void;
  /** "Order" on a card: straight into the cart, then the chat asks only for delivery time and address. */
  onOrderItem: (itemId: string) => void;
  onOpenPreferences: () => void;
}) {
  const catalog = useCatalog();
  const menu = catalog.categories;
  const apiFetch = useApiFetch();
  // The customer's hard constraints (saved allergens and dietary rules). Reloaded each time the home page opens,
  // so a change on the preferences screen applies at once. The server checks again on every add.
  const [constraints, setConstraints] = useState<{ allergens: string[]; dietary: string[] }>({ allergens: [], dietary: [] });
  useEffect(() => {
    void (async () => {
      const res = await apiFetch("/api/me/preferences");
      if (res.ok) setConstraints(((await res.json()) as { hard_constraints: { allergens: string[]; dietary: string[] } }).hard_constraints);
    })();
  }, [apiFetch]);
  const blockOf = (m: { allergens: string[]; dietary: string[] }): Block | null => {
    const allergens = m.allergens.filter((a) => constraints.allergens.includes(a));
    const dietary = constraints.dietary.filter((d) => !m.dietary.includes(d));
    return allergens.length || dietary.length ? { allergens, dietary } : null;
  };
  const blockText = (b: Block) => {
    const parts = [
      b.allergens.length ? (ja ? `登録中のアレルゲン（${b.allergens.map((a) => allergenLabel(a, locale)).join("・")}）を含みます` : `Contains your allergen: ${b.allergens.map((a) => allergenLabel(a, locale)).join(", ")}`) : "",
      b.dietary.length ? (ja ? `食事制限（${b.dietary.map((d) => dietaryLabel(d, locale)).join("・")}）に対応していません` : `Not ${b.dietary.map((d) => dietaryLabel(d, locale)).join(" / ")}`) : "",
    ].filter(Boolean);
    return parts.join(ja ? "。" : ". ");
  };
  const [active, setActive] = useState<string>("all");
  const [request, setRequest] = useState("");
  const ja = locale === "ja";

  function submit(e: FormEvent) {
    e.preventDefault();
    onAskAgent(request.trim() || undefined);
  }

  const slides: Slide[] = ja
    ? [
        { id: "sushi", title: "今日はお寿司？", sub: "話すだけで、AIが選んで注文", cta: "お寿司を頼む", onClick: () => onAskAgent("今日はお寿司が食べたい") },
        { id: "noodles", title: "温かい麺で、ほっと一息", sub: "うどん・そば・ラーメン", cta: "麺を頼む", onClick: () => onAskAgent("温かい麺を1人前") },
        { id: "prefs", title: "好みを覚えて、もっとラクに", sub: "好きな食材・苦手なものを登録", cta: "好みを登録", onClick: onOpenPreferences },
        { id: "safe", title: "アレルギーも安心", sub: "登録したアレルゲンは自動で除外", cta: "えびなしで探す", onClick: () => onAskAgent("えびを使っていない天ぷら定食") },
      ]
    : [
        { id: "sushi", title: "Sushi tonight?", sub: "Just say it, the AI picks and orders", cta: "Order sushi", onClick: () => onAskAgent("I want sushi today") },
        { id: "noodles", title: "Warm noodles, warm heart", sub: "Udon, soba, ramen", cta: "Order noodles", onClick: () => onAskAgent("Hot noodles for 1 person") },
        { id: "prefs", title: "It remembers your taste", sub: "Save the foods you love and avoid", cta: "Set preferences", onClick: onOpenPreferences },
        { id: "safe", title: "Allergy-safe by default", sub: "Saved allergens are always excluded", cta: "Find shrimp-free", onClick: () => onAskAgent("Tempura set without shrimp") },
      ];

  const shown = menu?.filter((c) => active === "all" || c.category === active) ?? [];
  return (
    <div className="home">
      <HeroCarousel slides={slides} label={ja ? "おすすめ" : "Featured"} />

      <form className="ask" onSubmit={submit}>
        <input
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          maxLength={500}
          placeholder={ja ? "何が食べたいですか？" : "What do you feel like eating?"}
          aria-label={ja ? "AIに注文" : "Order with AI"}
        />
        <button type="submit" className="primary">{ja ? "AIに注文" : "Ask AI"}</button>
      </form>
      <div className="chips ask__chips">
        {EXAMPLES[locale].map((ex) => (
          <button key={ex} type="button" onClick={() => onAskAgent(ex)}>{ex}</button>
        ))}
      </div>

      <HowToOrder locale={locale} onTry={(message) => onAskAgent(message)} onOpenPreferences={onOpenPreferences} />

      <nav className="category-nav" aria-label={ja ? "カテゴリー" : "Categories"}>
        <button type="button" className={active === "all" ? "tab active" : "tab"} onClick={() => setActive("all")}>{ja ? "すべて" : "All"}</button>
        {menu?.map((c) => {
          const meta = CATEGORIES[c.category];
          const photo = categoryPhoto(c.category);
          return (
            <button key={c.category} type="button" className={active === c.category ? "tab tab--photo active" : "tab tab--photo"} onClick={() => setActive(c.category)}>
              {photo && <img src={photo} alt="" className="tab__photo" />}
              {meta ? (ja ? meta.ja : meta.en) : c.category} <span className="muted">{c.items.length}</span>
            </button>
          );
        })}
      </nav>

      {!menu && <p className="muted center">…</p>}
      {shown.map((c) => {
        const meta = CATEGORIES[c.category] ?? { emoji: "🍽️", ja: c.category, en: c.category, tint: "#eee" };
        return (
          <section key={c.category} className="menu-section">
            <h2>{ja ? meta.ja : meta.en}</h2>
            <div className="menu-grid">
              {c.items.map((m) => {
                const name = catalog.itemName(m.itemId, m.name);
                const block = blockOf(m);
                const warning = block ? blockText(block) : "";
                return (
                <article key={m.itemId} className={block ? "menu-card menu-card--blocked" : "menu-card"} title={catalog.itemDescription(m)}>
                  <div className="menu-card__img" style={{ background: meta.tint }}>
                    <img src={menuPhoto(m.itemId)} alt={name} loading="lazy" onError={(e) => (e.currentTarget.style.display = "none")} />
                  </div>
                  <div className="menu-card__body">
                    <h3>{name}</h3>
                    <p className="muted small">{catalog.restaurantName(m)}{m.calories ? ` · ${m.calories}kcal` : ""}</p>
                    <p className="tags">
                      {m.tasteTags.slice(0, 2).map((t) => <span key={t} className="tag">{TAGS[t]?.[locale] ?? t}</span>)}
                      {m.dietary.slice(0, 1).map((d) => <span key={d} className="tag tag--ok">{dietaryLabel(d, locale)}</span>)}
                    </p>
                    <p className="allergens small">
                      ⚠{" "}
                      {m.allergens.length
                        ? m.allergens.map((a, i) => (
                            <span key={a}>{i > 0 && (ja ? "・" : ", ")}{MANDATORY_ALLERGENS.has(a) ? <strong>{allergenLabel(a, locale)}</strong> : allergenLabel(a, locale)}</span>
                          ))
                        : "—"}
                    </p>
                    {block && <p className="allergy-warning" role="note">⚠ {warning}</p>}
                  </div>
                  <div className="menu-card__foot">
                    <strong className="price">{catalog.money(m.priceInclTax)}</strong>
                    {m.isSoldOut ? (
                      <span className="muted">{ja ? "売り切れ" : "Sold out"}</span>
                    ) : (
                      <CardActions itemId={m.itemId} name={name} ja={ja} blockedReason={warning || null} onOrder={() => onOrderItem(m.itemId)} />
                    )}
                  </div>
                </article>
                );
              })}
            </div>
          </section>
        );
      })}

      <p className="photo-credit small muted">
        {ja ? "写真はイメージです。" : "Photos are illustrative. "}
        <a href="/photo-credits.html" target="_blank" rel="noopener">{ja ? "写真クレジット（Wikimedia Commons）" : "Photo credits (Wikimedia Commons)"}</a>
      </p>

      <button type="button" className="fab primary" onClick={() => onAskAgent()} aria-label={ja ? "AIアシスタントに相談" : "Ask the AI assistant"}>
        💬 {ja ? "AIアシスタント" : "AI assistant"}
      </button>
    </div>
  );
}

const ADD_ERRORS: Record<string, { ja: string; en: string }> = {
  ALLERGEN_CONFLICT: { ja: "登録中のアレルゲンを含むため追加できません。", en: "Contains an allergen in your settings." },
  DIETARY_CONFLICT: { ja: "食事制限の設定に合わないため追加できません。", en: "Does not match your dietary settings." },
  ITEM_SOLD_OUT: { ja: "在庫が足りないため追加できません。", en: "Not enough stock left." },
  QUANTITY_LIMIT: { ja: "1回の注文で同じ料理は20個までです。", en: "Up to 20 of the same dish per order." },
};

/**
 * "Add to cart" (stays on the home page; the menu badge updates) + "Order" (straight to payment in the chat).
 * One order = one restaurant: adding a dish from another shop asks before emptying the cart.
 */
function CardActions({ itemId, name, ja, blockedReason, onOrder }: {
  itemId: string;
  name: string;
  ja: boolean;
  /** Set when the dish conflicts with the customer's allergens / dietary rules: both buttons only show the warning. */
  blockedReason: string | null;
  onOrder: () => void;
}) {
  const { addItem } = useCart();
  const [state, setState] = useState<"idle" | "busy" | "added" | "replace" | "error">("idle");
  const [error, setError] = useState("");
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const warnBlocked = () => {
    setError(ja ? `${blockedReason}。ご注文・カートへの追加はできません（設定は「好みの設定」で変更できます）。` : `${blockedReason}. It cannot be ordered or added to the cart (you can change this under Preferences).`);
    setState("error");
  };
  const order = () => (blockedReason ? warnBlocked() : onOrder());

  async function add(replaceCart = false) {
    if (blockedReason) return warnBlocked();
    setState("busy");
    const r = await addItem(itemId, { replaceCart });
    if (r.ok) {
      setState("added");
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setState("idle"), 1800);
    } else if (r.code === "DIFFERENT_RESTAURANT") {
      setState("replace");
    } else {
      setError(ADD_ERRORS[r.code]?.[ja ? "ja" : "en"] ?? (ja ? "追加できませんでした。" : "Could not add to cart."));
      setState("error");
    }
  }

  return (
    <>
      <div className="card-actions">
        <button
          type="button"
          className={state === "added" ? "add-to-cart added" : "add-to-cart"}
          disabled={state === "busy"}
          aria-label={ja ? `${name} をカートに追加` : `Add ${name} to cart`}
          onClick={() => add()}
        >
          {state === "added" ? (
            <>✓ {ja ? "追加済み" : "Added"}</>
          ) : (
            <>
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="9" cy="20" r="1.5" />
                <circle cx="18" cy="20" r="1.5" />
                <path d="M2.5 3h2.6l2.4 12.2a1.5 1.5 0 0 0 1.5 1.2h8.9a1.5 1.5 0 0 0 1.5-1.1L21.5 7H6" />
              </svg>
              {ja ? "カートに追加" : "Add to cart"}
            </>
          )}
        </button>
        <button type="button" className="order-now" onClick={order}>{ja ? "注文" : "Order"}</button>
      </div>
      <span className="sr-only" aria-live="polite">{state === "added" ? (ja ? `${name} をカートに追加しました` : `${name} added to cart`) : ""}</span>
      {state === "replace" && (
        <div className="card-notice" role="alert">
          <span>{ja ? "カートに別のお店の料理があります（1回の注文は1店舗のみ）。カートを空にして追加しますか？" : "Your cart has dishes from another restaurant (one restaurant per order). Empty the cart and add this?"}</span>
          <span className="card-notice__actions">
            <button type="button" className="primary" onClick={() => add(true)}>{ja ? "空にして追加" : "Empty & add"}</button>
            <button type="button" onClick={() => setState("idle")}>{ja ? "キャンセル" : "Cancel"}</button>
          </span>
        </div>
      )}
      {state === "error" && (
        <div className="card-notice card-notice--error" role="alert">
          <span>{error}</span>
          <span className="card-notice__actions">
            <button type="button" onClick={() => setState("idle")}>OK</button>
          </span>
        </div>
      )}
    </>
  );
}
