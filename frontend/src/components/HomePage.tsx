import { useEffect, useState, type FormEvent } from "react";
import { useApiFetch, yen } from "../api/client";
import { ALLERGEN_JA, CATEGORIES, MANDATORY_ALLERGENS, TAGS } from "../labels";
import { HeroCarousel, type Slide } from "./HeroCarousel";

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
  ja: ["サーモン寿司 1人前", "温かい麺 2人分", "えびなし天ぷら"],
  en: ["Salmon sushi for 1", "Hot noodles for 2", "Tempura, no shrimp"],
};

/** Home: menu by category + entry points into the AI ordering chat. */
export function HomePage({ locale, onAskAgent, onOpenPreferences }: { locale: "ja" | "en"; onAskAgent: (message?: string) => void; onOpenPreferences: () => void }) {
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

  const slides: Slide[] = ja
    ? [
        { id: "sushi", emoji: ["🍣", "🐟"], title: "今日はお寿司？", sub: "話すだけで、AIが選んで注文", cta: "お寿司を頼む", onClick: () => onAskAgent("今日はお寿司が食べたい") },
        { id: "noodles", emoji: ["🍜", "♨️"], title: "温かい麺で、ほっと一息", sub: "うどん・そば・ラーメン", cta: "麺を頼む", onClick: () => onAskAgent("温かい麺を1人前") },
        { id: "prefs", emoji: ["💚", "🥗"], title: "好みを覚えて、もっとラクに", sub: "好きな食材・苦手なものを登録", cta: "好みを登録", onClick: onOpenPreferences },
        { id: "safe", emoji: ["🍤", "🚫"], title: "アレルギーも安心", sub: "登録したアレルゲンは自動で除外", cta: "えびなしで探す", onClick: () => onAskAgent("えびを使っていない天ぷら定食") },
      ]
    : [
        { id: "sushi", emoji: ["🍣", "🐟"], title: "Sushi tonight?", sub: "Just say it, the AI picks and orders", cta: "Order sushi", onClick: () => onAskAgent("I want sushi today") },
        { id: "noodles", emoji: ["🍜", "♨️"], title: "Warm noodles, warm heart", sub: "Udon, soba, ramen", cta: "Order noodles", onClick: () => onAskAgent("Hot noodles for 1 person") },
        { id: "prefs", emoji: ["💚", "🥗"], title: "It remembers your taste", sub: "Save the foods you love and avoid", cta: "Set preferences", onClick: onOpenPreferences },
        { id: "safe", emoji: ["🍤", "🚫"], title: "Allergy-safe by default", sub: "Saved allergens are always excluded", cta: "Find shrimp-free", onClick: () => onAskAgent("Tempura set without shrimp") },
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
                    <p className="tags">
                      {m.tasteTags.slice(0, 2).map((t) => <span key={t} className="tag">{TAGS[t]?.[locale] ?? t}</span>)}
                      {m.dietary.slice(0, 1).map((d) => <span key={d} className="tag tag--ok">{d}</span>)}
                    </p>
                    <p className="allergens small">
                      ⚠{" "}
                      {m.allergens.length
                        ? m.allergens.map((a, i) => (
                            <span key={a}>{i > 0 && "・"}{MANDATORY_ALLERGENS.has(a) ? <strong>{ALLERGEN_JA[a] ?? a}</strong> : ALLERGEN_JA[a] ?? a}</span>
                          ))
                        : "—"}
                    </p>
                  </div>
                  <div className="menu-card__foot">
                    <strong className="price">{yen(m.priceInclTax)}</strong>
                    {m.isSoldOut ? (
                      <span className="muted">{ja ? "売り切れ" : "Sold out"}</span>
                    ) : (
                      <button type="button" onClick={() => onAskAgent(ja ? `「${m.name}」を1人前注文したいです` : `I'd like to order one "${m.name}"`)}>
                        {ja ? "注文" : "Order"}
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
