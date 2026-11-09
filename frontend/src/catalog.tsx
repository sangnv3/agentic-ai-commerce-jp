import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useApiFetch } from "./api/client";

export interface MenuItem {
  itemId: string;
  name: string;
  nameEn: string | null;
  description: string;
  descriptionEn: string | null;
  restaurant: string;
  restaurantEn: string | null;
  priceInclTax: number;
  allergens: string[];
  dietary: string[];
  tasteTags: string[];
  calories: number | null;
  isSoldOut: boolean;
}
export interface Category {
  category: string;
  items: MenuItem[];
}
interface MenuResponse {
  categories: Category[];
  optionNames: Record<string, { ja: string; en: string | null }>;
  fx: Record<string, number>;
}
/** A checkout / receipt line: the Japanese label from the server, plus ids to show it in another language. */
export interface PricedLine {
  label: string;
  item_id?: string;
  option_keys?: string[];
  coupon_code?: string;
}

export interface Catalog {
  locale: "ja" | "en";
  /** null while loading; [] if the menu could not be loaded. */
  categories: Category[] | null;
  itemName: (itemId: string, fallback: string) => string;
  itemDescription: (m: MenuItem) => string;
  restaurantName: (m: MenuItem) => string;
  /** Restaurant name for an item id (used by chat cards, which carry the Japanese name only). */
  restaurantOf: (itemId: string, fallback: string) => string;
  lineLabel: (line: PricedLine) => string;
  /** "group" or "group.choice" (e.g. "rice.less") → label in the selected language. */
  optionName: (key: string) => string | null;
  /** Price in the visitor's currency: ¥ in Japanese, US$ in English (demo: converted at the configured rate). */
  money: (yen: number) => string;
}

const CatalogContext = createContext<Catalog | null>(null);
const yenFmt = (n: number) => `¥${n.toLocaleString("ja-JP")}`;

/** Loads the menu once and localizes names and prices for the selected language (switching needs no reload). */
export function CatalogProvider({ locale, children }: { locale: "ja" | "en"; children: ReactNode }) {
  const apiFetch = useApiFetch();
  const [data, setData] = useState<MenuResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await apiFetch("/api/menu");
        if (!res.ok) throw new Error(String(res.status));
        setData((await res.json()) as MenuResponse);
      } catch {
        setFailed(true);
      }
    })();
  }, [apiFetch]);

  const value = useMemo<Catalog>(() => {
    const en = locale === "en";
    const byId = new Map<string, MenuItem>();
    for (const c of data?.categories ?? []) for (const m of c.items) byId.set(m.itemId, m);
    const usd = data?.fx?.USD;
    const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const converted = en && !!usd;

    const itemName = (id: string, fallback: string) => (en ? byId.get(id)?.nameEn : byId.get(id)?.name) ?? fallback;
    const optionName = (key: string) => {
      const o = data?.optionNames[key];
      return o ? (en ? o.en ?? o.ja : o.ja) : null;
    };
    return {
      locale,
      categories: data ? data.categories : failed ? [] : null,
      itemName,
      itemDescription: (m) => (en ? m.descriptionEn : null) ?? m.description,
      restaurantName: (m) => (en ? m.restaurantEn : null) ?? m.restaurant,
      restaurantOf: (id, fallback) => {
        const m = byId.get(id);
        return (m && (en ? m.restaurantEn ?? m.restaurant : m.restaurant)) ?? fallback;
      },
      lineLabel: (l) => {
        if (!en) return l.label;
        if (l.coupon_code) return `Coupon ${l.coupon_code}`;
        const name = l.item_id ? byId.get(l.item_id)?.nameEn : null;
        if (!name) return l.label; // older orders / untranslated item: keep the Japanese label
        const opts = (l.option_keys ?? []).map(optionName).filter(Boolean);
        return opts.length ? `${name} (${opts.join(", ")})` : name;
      },
      optionName,
      money: (n) => (converted ? usdFmt.format(n / usd!) : yenFmt(n)),
    };
  }, [data, failed, locale]);

  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;
}

export function useCatalog(): Catalog {
  const c = useContext(CatalogContext);
  if (!c) throw new Error("useCatalog must be used inside <CatalogProvider>");
  return c;
}
