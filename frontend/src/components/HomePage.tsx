import { useEffect, useState, type FormEvent } from "react";
import { useApiFetch, yen } from "../api/client";
import { ALLERGEN_JA, CATEGORIES, MANDATORY_ALLERGENS, TAGS } from "../labels";

interface MenuItem {
  itemId: string;
  name: string;
  description: string;
  restaurant: string;
  priceInclTax: number;
  allergens: string[];
  dietary: string[];
  tasteTags: string[];
  calories: number | null;
  isSoldOut: boolean;
}
interface Category {
  category: string;
  items: MenuItem[];
}

const EXAMPLES = {
  ja: ["サーモン入りの寿司、1人前、5,000円以下", "温かい麺を2人分、3,000円以内で", "えびを使っていない天ぷら定食", "I want salmon sushi for 1 person under $5"],
  en: ["Salmon sushi for 1 person under ¥5,000", "Hot noodles for 2 people within ¥3,000", "Tempura set without shrimp", "サーモンの寿司、1人、5ドル以下"],
};

/** Home: menu by category + entry points into the AI ordering chat. */
export function HomePage({ locale, onAskAgent }: { locale: "ja" | "en"; onAskAgent: (message?: string) => void }) {
  const apiFetch = useApiFetch();
  const [menu, setMenu] = useState<Category[] | null>(null);
  const [active, setActive] = useState<string>("all");
  const [request, setRequest] = useState("");
  const ja = locale === "ja";

  useEffect(() => {
    void (async () => {
      const res = await apiFetch("/api/menu");
      setMenu(res.ok ? ((await res.json()) as { categories: Category[] }).categories : []);
    })();
  }, [apiFetch]);

  function submit(e: FormEvent) {
    e.preventDefault();
    onAskAgent(request.trim() || undefined);
  }

  const shown = menu?.filter((c) => active === "all" || c.category === active) ?? [];
  return (
    <div className="home">
      <section className="hero">
        <h1>{ja ? "食べたいものを、話すだけ。" : "Just say what you want to eat."}</h1>
        <p className="muted">
          {ja
            ? "AIアシスタントが料理を探し、カートに入れ、お会計の準備まで行います。最後に「確認して支払う」を押すだけです。"
            : "The AI assistant finds dishes, fills your cart and prepares checkout. You only press “Confirm & Pay”."}
        </p>
        <form className="hero__form" onSubmit={submit}>
          <textarea
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
            }}
            rows={2}
            maxLength={500}
            placeholder={ja ? "例：サーモン入りの寿司、1人前、5,000円以下" : "e.g. Salmon sushi for 1 person under ¥5,000"}
          />
          <button type="submit" className="primary">{ja ? "AIに注文をお願いする 💬" : "Order with AI 💬"}</button>
        </form>
        <div className="chips">
          {EXAMPLES[locale].map((ex) => (
            <button key={ex} type="button" onClick={() => onAskAgent(ex)}>{ex}</button>
          ))}
        </div>
      </section>

      <nav className="category-nav" aria-label={ja ? "カテゴリー" : "Categories"}>
        <button type="button" className={active === "all" ? "tab active" : "tab"} onClick={() => setActive("all")}>{ja ? "すべて" : "All"}</button>
        {menu?.map((c) => {
          const meta = CATEGORIES[c.category];
          return (
            <button key={c.category} type="button" className={active === c.category ? "tab active" : "tab"} onClick={() => setActive(c.category)}>
              {meta?.emoji} {meta ? (ja ? meta.ja : meta.en) : c.category} <span className="muted">{c.items.length}</span>
            </button>
          );
        })}
      </nav>

      {!menu && <p className="muted center">…</p>}
      {shown.map((c) => {
        const meta = CATEGORIES[c.category] ?? { emoji: "🍽️", ja: c.category, en: c.category, tint: "#eee" };
        return (
          <section key={c.category} className="menu-section">
            <h2>{meta.emoji} {ja ? meta.ja : meta.en}</h2>
            <div className="menu-grid">
              {c.items.map((m) => (
                <article key={m.itemId} className="menu-card">
                  <div className="menu-card__img" style={{ background: meta.tint }} aria-hidden>{meta.emoji}</div>
                  <div className="menu-card__body">
                    <h3>{m.name}</h3>
                    <p className="muted small">{m.restaurant}{m.calories ? ` · ${m.calories}kcal` : ""}</p>
                    <p className="small">{m.description}</p>
                    <p className="tags">
                      {m.tasteTags.map((t) => <span key={t} className="tag">{TAGS[t]?.[locale] ?? t}</span>)}
                      {m.dietary.map((d) => <span key={d} className="tag tag--ok">{d}</span>)}
                    </p>
                    <p className="allergens small">
                      {ja ? "アレルゲン: " : "Allergens: "}
                      {m.allergens.length
                        ? m.allergens.map((a, i) => (
                            <span key={a}>{i > 0 && "・"}{MANDATORY_ALLERGENS.has(a) ? <strong>{ALLERGEN_JA[a] ?? a}</strong> : ALLERGEN_JA[a] ?? a}</span>
                          ))
                        : "—"}
                    </p>
                  </div>
                  <div className="menu-card__foot">
                    <strong className="price">{yen(m.priceInclTax)}<span className="muted small">{ja ? "（税込）" : " incl. tax"}</span></strong>
                    {m.isSoldOut ? (
                      <span className="muted">{ja ? "売り切れ" : "Sold out"}</span>
                    ) : (
                      <button type="button" onClick={() => onAskAgent(ja ? `「${m.name}」を1人前注文したいです` : `I'd like to order one "${m.name}"`)}>
                        {ja ? "AIで注文" : "Order via AI"}
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </section>
        );
      })}

      <button type="button" className="fab primary" onClick={() => onAskAgent()} aria-label={ja ? "AIアシスタントに相談" : "Ask the AI assistant"}>
        💬 {ja ? "AIアシスタント" : "AI assistant"}
      </button>
    </div>
  );
}
