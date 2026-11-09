import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { useApiFetch } from "../api/client";
import { ALLERGEN_JA, MANDATORY_ALLERGENS, TAGS } from "../labels";

interface Stated {
  favorite_foods: string[];
  avoid_foods: string[];
  taste_like: string[];
  taste_avoid: string[];
  cuisines: string[];
  budget_per_person: number | null;
  note: string;
}
interface PendingChange {
  id: string;
  kind: string;
  subject: string | null;
  quote: string | null;
}
interface PreferencesResponse {
  hard_constraints: { allergens: string[]; dietary: string[] };
  stated: Stated & { updated_at: string | null };
  pending_changes: PendingChange[];
}

const TASTES = ["light", "low_oil", "hearty", "spicy", "mild", "high_protein", "low_calorie", "low_carb", "vegetable_rich"];
const CUISINES: Record<string, { ja: string; en: string }> = {
  japanese: { ja: "和食", en: "Japanese" }, chinese: { ja: "中華", en: "Chinese" }, korean: { ja: "韓国料理", en: "Korean" },
  western: { ja: "洋食", en: "Western" }, italian: { ja: "イタリアン", en: "Italian" }, ethnic: { ja: "エスニック", en: "Ethnic" },
};
const DIETARY: Record<string, { ja: string; en: string }> = {
  vegetarian: { ja: "ベジタリアン", en: "Vegetarian" }, vegan: { ja: "ヴィーガン", en: "Vegan" }, halal: { ja: "ハラール", en: "Halal" },
  low_carb: { ja: "低糖質", en: "Low carb" }, gluten_free: { ja: "グルテンフリー", en: "Gluten free" },
};
const ALLERGEN_EN: Record<string, string> = { salmon_roe: "salmon roe" };

const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

/** Free-text food list (chips): Enter or comma adds, × removes. */
function FoodInput({ label, hint, values, onChange, placeholder, tone }: {
  label: string; hint: string; values: string[]; onChange: (v: string[]) => void; placeholder: string; tone: "like" | "avoid";
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const parts = draft.split(/[,、，]/).map((s) => s.trim()).filter(Boolean);
    if (parts.length) onChange([...new Set([...values, ...parts])].slice(0, 15));
    setDraft("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === "Enter" || e.key === ",") && !e.nativeEvent.isComposing) {
      e.preventDefault();
      add();
    }
  };
  return (
    <div className="pref-field">
      <label>{label}<span className="muted small"> — {hint}</span></label>
      <div className="pref-foods">
        {values.map((v) => (
          <span key={v} className={`pref-chip pref-chip--${tone}`}>
            {v}
            <button type="button" aria-label={`remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>×</button>
          </span>
        ))}
        <input value={draft} maxLength={40} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} onBlur={add} placeholder={placeholder} />
      </div>
    </div>
  );
}

/** "My preferences": the customer's own food preferences, used by the AI when choosing and ordering dishes. */
export function PreferencesPanel({ locale, onTryAgent }: { locale: "ja" | "en"; onTryAgent: (message: string) => void }) {
  const apiFetch = useApiFetch();
  const ja = locale === "ja";
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [stated, setStated] = useState<Stated>({ favorite_foods: [], avoid_foods: [], taste_like: [], taste_avoid: [], cuisines: [], budget_per_person: null, note: "" });
  const [allergens, setAllergens] = useState<string[]>([]);
  const [dietary, setDietary] = useState<string[]>([]);
  const [pending, setPending] = useState<PendingChange[]>([]);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await apiFetch("/api/me/preferences");
      if (!res.ok) return setLoadError(true);
      const p = (await res.json()) as PreferencesResponse;
      const { updated_at, ...rest } = p.stated;
      setStated(rest);
      setSavedAt(updated_at);
      setAllergens(p.hard_constraints.allergens);
      setDietary(p.hard_constraints.dietary);
      setPending(p.pending_changes);
      setLoaded(true);
    })();
  }, [apiFetch]);

  const set = <K extends keyof Stated>(k: K, v: Stated[K]) => {
    setStated((s) => ({ ...s, [k]: v }));
    setStatus("idle");
  };

  /** Taste chip cycles: neutral → like → avoid → neutral. */
  function cycleTaste(t: string) {
    setStatus("idle");
    setStated((s) => {
      if (s.taste_like.includes(t)) return { ...s, taste_like: s.taste_like.filter((x) => x !== t), taste_avoid: [...s.taste_avoid, t] };
      if (s.taste_avoid.includes(t)) return { ...s, taste_avoid: s.taste_avoid.filter((x) => x !== t) };
      return { ...s, taste_like: [...s.taste_like, t] };
    });
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setStatus("saving");
    const res = await apiFetch("/api/me/preferences", { method: "PUT", body: JSON.stringify({ allergens, dietary, stated }) });
    if (!res.ok) return setStatus("error");
    const out = (await res.json()) as { stated: { updated_at: string } };
    setSavedAt(out.stated.updated_at);
    setPending([]);
    setStatus("saved");
  }

  if (loadError) return <p className="panel error">{ja ? "読み込めませんでした。" : "Could not load your preferences."}</p>;
  if (!loaded) return <p className="panel">…</p>;

  const example = stated.favorite_foods.length || stated.taste_like.length
    ? (ja ? "今日はお寿司が食べたい" : "I want sushi today")
    : null;
  const pendingLabel = (c: PendingChange) => {
    const s = c.subject ?? "";
    const name = (ja ? ALLERGEN_JA[s] ?? DIETARY[s]?.ja : DIETARY[s]?.en ?? ALLERGEN_EN[s]) ?? s;
    const verb = c.kind === "allergen_add_request" ? (ja ? "アレルゲンに追加" : "add allergen") : c.kind === "allergen_remove_request" ? (ja ? "アレルゲンから削除" : "remove allergen") : (ja ? "食事制限を変更" : "change dietary");
    return `${verb}: ${name}`;
  };

  return (
    <form className="panel prefs" onSubmit={save}>
      <h2>{ja ? "私の好み" : "My preferences"}</h2>
      <p className="muted">
        {ja
          ? "ここに入力した好みは、AIが料理を選んで注文するときに使われます。「今日はお寿司」と言うだけで、好みに合うお寿司を選んでカートに入れます。"
          : "The AI uses these when it picks and orders dishes for you. Just say “sushi today” and it chooses the sushi that fits your taste."}
      </p>

      {pending.length > 0 && (
        <div className="pref-pending" role="status">
          <strong>{ja ? "チャットで依頼された変更（未反映）" : "Changes you asked for in chat (not applied yet)"}</strong>
          <ul>
            {pending.map((c) => (
              <li key={c.id}>
                {pendingLabel(c)}
                {c.quote && <span className="muted small"> 「{c.quote}」</span>}
              </li>
            ))}
          </ul>
          <span className="muted small">
            {ja ? "下のアレルゲン・食事制限で選択して保存すると反映されます。選択せずに保存すると取り消されます。" : "Tick them below and save to apply; saving without them discards the request."}
          </span>
        </div>
      )}

      <fieldset>
        <legend>{ja ? "好きなもの・苦手なもの" : "Foods you like and avoid"}</legend>
        <FoodInput
          tone="like"
          label={ja ? "好きな食べ物・食材" : "Favorite foods"}
          hint={ja ? "Enterで追加" : "press Enter to add"}
          values={stated.favorite_foods}
          onChange={(v) => set("favorite_foods", v)}
          placeholder={ja ? "例：サーモン、まぐろ、鶏肉" : "e.g. salmon, tuna, chicken"}
        />
        <FoodInput
          tone="avoid"
          label={ja ? "苦手な食べ物・避けたいもの" : "Foods to avoid"}
          hint={ja ? "アレルギーではないもの" : "not allergies"}
          values={stated.avoid_foods}
          onChange={(v) => set("avoid_foods", v)}
          placeholder={ja ? "例：わさび、生玉ねぎ、パクチー" : "e.g. wasabi, raw onion, cilantro"}
        />
      </fieldset>

      <fieldset>
        <legend>{ja ? "味の好み" : "Taste"}</legend>
        <p className="muted small">{ja ? "タップで 好き 👍 → 苦手 👎 → 指定なし" : "Tap: like 👍 → avoid 👎 → no preference"}</p>
        <div className="chips">
          {TASTES.map((t) => {
            const state = stated.taste_like.includes(t) ? "like" : stated.taste_avoid.includes(t) ? "avoid" : "none";
            return (
              <button key={t} type="button" className={`pref-toggle pref-toggle--${state}`} aria-pressed={state !== "none"} onClick={() => cycleTaste(t)}>
                {state === "like" ? "👍 " : state === "avoid" ? "👎 " : ""}{TAGS[t]?.[locale] ?? t}
              </button>
            );
          })}
        </div>
      </fieldset>

      <fieldset>
        <legend>{ja ? "好きなジャンル" : "Favorite cuisines"}</legend>
        <div className="chips">
          {Object.entries(CUISINES).map(([c, l]) => (
            <button key={c} type="button" className={`pref-toggle ${stated.cuisines.includes(c) ? "pref-toggle--like" : "pref-toggle--none"}`} aria-pressed={stated.cuisines.includes(c)} onClick={() => set("cuisines", toggle(stated.cuisines, c))}>
              {l[locale]}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>{ja ? "予算とメモ" : "Budget and notes"}</legend>
        <div className="pref-field">
          <label htmlFor="pref-budget">{ja ? "1人あたりの予算（税込・円）" : "Budget per person (JPY, tax incl.)"}</label>
          <input
            id="pref-budget"
            type="number"
            inputMode="numeric"
            min={300}
            max={20000}
            step={100}
            value={stated.budget_per_person ?? ""}
            onChange={(e) => set("budget_per_person", e.target.value === "" ? null : Math.round(Number(e.target.value)))}
            placeholder={ja ? "例：1500" : "e.g. 1500"}
          />
        </div>
        <div className="pref-field">
          <label htmlFor="pref-note">{ja ? "その他の希望" : "Anything else"}</label>
          <textarea id="pref-note" rows={2} maxLength={300} value={stated.note} onChange={(e) => set("note", e.target.value)} placeholder={ja ? "例：量は少なめが好き、温かい料理が好き" : "e.g. small portions, I prefer hot dishes"} />
        </div>
      </fieldset>

      <fieldset className="pref-hard">
        <legend>{ja ? "アレルゲン（必ず除外）" : "Allergens (always excluded)"}</legend>
        <p className="muted small">
          {ja ? "選んだアレルゲンを含む料理は、AIが提案もカート追加もできません。太字は特定原材料です。" : "The AI can never suggest or add dishes containing these. Bold = mandatory-labelling allergens."}
        </p>
        <div className="pref-allergens">
          {Object.keys(ALLERGEN_JA).map((a) => (
            <label key={a} className="pref-check">
              <input type="checkbox" checked={allergens.includes(a)} onChange={() => { setAllergens(toggle(allergens, a)); setStatus("idle"); }} />
              {MANDATORY_ALLERGENS.has(a) ? <strong>{ja ? ALLERGEN_JA[a] : ALLERGEN_EN[a] ?? a}</strong> : ja ? ALLERGEN_JA[a] : ALLERGEN_EN[a] ?? a}
            </label>
          ))}
        </div>
        <p className="pref-sublegend"><strong>{ja ? "食事制限" : "Dietary requirements"}</strong></p>
        <div className="chips">
          {Object.entries(DIETARY).map(([d, l]) => (
            <label key={d} className="pref-check">
              <input type="checkbox" checked={dietary.includes(d)} onChange={() => { setDietary(toggle(dietary, d)); setStatus("idle"); }} />
              {l[locale]}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="pref-actions">
        <button type="submit" className="primary" disabled={status === "saving"}>
          {status === "saving" ? "…" : ja ? "保存する" : "Save"}
        </button>
        {status === "saved" && <span className="badge">✓ {ja ? "保存しました。次のメッセージから反映されます。" : "Saved. The AI uses it from your next message."}</span>}
        {status === "error" && <span className="error">{ja ? "保存できませんでした。入力内容を確認してください。" : "Could not save. Please check your entries."}</span>}
        {status !== "saved" && savedAt && <span className="muted small">{ja ? "最終更新: " : "Last saved: "}{new Date(savedAt).toLocaleString(ja ? "ja-JP" : "en-US", { timeZone: "Asia/Tokyo", dateStyle: "medium", timeStyle: "short" })}</span>}
        {status === "saved" && example && (
          <button type="button" onClick={() => onTryAgent(example)}>💬 {ja ? `「${example}」と試す` : `Try “${example}”`}</button>
        )}
      </div>
    </form>
  );
}
