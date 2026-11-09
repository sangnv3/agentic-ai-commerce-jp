import { db, type Tx } from "../db/pool.js";
import { CommerceError } from "./errors.js";

export interface OptionChoice {
  id: string;
  name: string;
  priceDelta: number;
  allergensAdded: string[];
}
export interface OptionGroup {
  id: string;
  name: string;
  required: boolean;
  options: OptionChoice[];
}
export interface MenuItem {
  itemId: string;
  restaurantId: string;
  restaurantName: string;
  name: string;
  description: string;
  priceInclTax: number;
  taxCategory: "reduced_8" | "standard_10";
  category: string | null;
  cuisine: string | null;
  servingTemp: string | null;
  allergens: string[];
  allergenDataComplete: boolean;
  mayContain: string[];
  dietary: string[];
  tasteTags: string[];
  calories: number | null;
  stock: number | null; // null = unlimited
  isSoldOut: boolean;
  servingFromMin: number;
  servingToMin: number;
  optionGroups: OptionGroup[];
}

const timeToMin = (t: string | null, d: number) => (t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : d);

const SELECT_ITEMS = `
  SELECT m.*, r.name_ja AS restaurant_name,
         COALESCE((SELECT json_agg(json_build_object('id', o.option_group_id, 'name', o.name_ja, 'required', o.required, 'options', o.options) ORDER BY o.sort_order)
                   FROM menu_item_options o WHERE o.item_id = m.item_id), '[]') AS option_groups
    FROM menu_items m JOIN restaurants r USING (restaurant_id)`;

function mapItem(r: Record<string, any>): MenuItem { // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    itemId: r.item_id,
    restaurantId: r.restaurant_id,
    restaurantName: r.restaurant_name,
    name: r.name_ja,
    description: r.description_ja ?? "",
    priceInclTax: r.price_incl_tax,
    taxCategory: r.tax_category,
    category: r.category,
    cuisine: r.cuisine,
    servingTemp: r.serving_temp,
    allergens: r.allergens,
    allergenDataComplete: r.allergen_data_complete,
    mayContain: r.may_contain,
    dietary: r.dietary_tags,
    tasteTags: r.taste_tags,
    calories: r.calories,
    stock: r.daily_stock,
    isSoldOut: r.is_sold_out || (r.daily_stock !== null && r.daily_stock <= 0),
    servingFromMin: timeToMin(r.available_from, 0),
    servingToMin: timeToMin(r.available_to, 24 * 60),
    optionGroups: r.option_groups,
  };
}

export async function getMenuItem(itemId: string, c: Tx | typeof db = db): Promise<MenuItem> {
  const { rows } = await c.query(`${SELECT_ITEMS} WHERE m.item_id = $1`, [itemId]);
  if (!rows[0]) throw new CommerceError("NOT_FOUND", `Menu item ${itemId} not found`);
  return mapItem(rows[0]);
}

export async function getMenuItems(itemIds: string[], c: Tx | typeof db = db): Promise<MenuItem[]> {
  if (!itemIds.length) return [];
  const { rows } = await c.query(`${SELECT_ITEMS} WHERE m.item_id = ANY($1)`, [itemIds]);
  return rows.map(mapItem);
}

/** Allergens from the source of truth (used to re-check search results). */
export async function allergensOf(itemIds: string[]): Promise<Record<string, string[]>> {
  const { rows } = await db.query<{ item_id: string; allergens: string[] }>("SELECT item_id, allergens FROM menu_items WHERE item_id = ANY($1)", [itemIds]);
  return Object.fromEntries(rows.map((r) => [r.item_id, r.allergens]));
}

/** Real-time stock check. */
export async function inventory(items: { itemId: string; quantity: number }[]) {
  const found = await getMenuItems(items.map((i) => i.itemId));
  return items.map((i) => {
    const m = found.find((f) => f.itemId === i.itemId);
    if (!m) return { itemId: i.itemId, available: false, remaining: 0, reason: "NOT_FOUND" };
    if (m.isSoldOut) return { itemId: i.itemId, available: false, remaining: 0, reason: "SOLD_OUT" };
    if (m.stock !== null && m.stock < i.quantity) return { itemId: i.itemId, available: false, remaining: m.stock, reason: "INSUFFICIENT_STOCK" };
    return { itemId: i.itemId, available: true, remaining: m.stock, reason: null };
  });
}

/** Price and allergens for a chosen set of options (required groups default to their first option). */
export function resolveOptions(m: MenuItem, chosen: Record<string, string>) {
  let delta = 0;
  const names: string[] = [];
  const allergens: string[] = [];
  const resolved: Record<string, string> = {};
  for (const g of m.optionGroups) {
    const id = chosen[g.id] ?? (g.required ? g.options[0]?.id : undefined);
    if (!id) continue;
    const o = g.options.find((x) => x.id === id);
    if (!o) throw new CommerceError("INVALID_OPTION", `Option ${g.id}=${id} does not exist for ${m.name}`);
    resolved[g.id] = o.id;
    delta += o.priceDelta;
    allergens.push(...o.allergensAdded);
    if (o.priceDelta !== 0 || o.id !== g.options[0]?.id) names.push(o.name);
  }
  for (const k of Object.keys(chosen)) {
    if (!m.optionGroups.some((g) => g.id === k)) throw new CommerceError("INVALID_OPTION", `${m.name} has no option group "${k}"`);
  }
  return { delta, names, allergens, resolved };
}

// ---------- search without Algolia (local dev / when ALGOLIA_APP_ID is empty) ----------
const TAG_WORDS: Record<string, string> = {
  light: "軽め あっさり ヘルシー さっぱり やさしい 蒸し", low_oil: "油控えめ 油少なめ ヘルシー 蒸し", hearty: "がっつり ボリューム", mild: "やさしい まろやか",
  spicy: "辛い ピリ辛", high_protein: "高たんぱく 鶏", noodles: "麺 うどん そば ラーメン", rice: "ご飯 丼 定食", bento: "弁当",
};

/** Same filter grammar the ranker sends to Algolia, evaluated in memory over the menu table. */
export async function localSearch(query: string, filters: string, limit: number) {
  const { rows } = await db.query(SELECT_ITEMS);
  const items = rows.map(mapItem);
  const conds = filters.split(" AND ").filter(Boolean);
  const num = (m: MenuItem, attr: string) =>
    ({ price_incl_tax: m.priceInclTax, calories: m.calories ?? 0, serving_from_min: m.servingFromMin, serving_to_min: m.servingToMin })[attr] ?? 0;
  const pass = (m: MenuItem, zoneOk: (z: string) => boolean) =>
    conds.every((c) => {
      let r: RegExpMatchArray | null;
      if ((r = c.match(/^NOT allergens:"(.+)"$/))) return !m.allergens.includes(r[1]);
      if ((r = c.match(/^dietary_tags:"(.+)"$/))) return m.dietary.includes(r[1]);
      if ((r = c.match(/^delivery_area_codes:"(.+)"$/))) return zoneOk(r[1]);
      if ((r = c.match(/^category:"(.+)"$/))) return m.category === r[1];
      if ((r = c.match(/^cuisine:"(.+)"$/))) return m.cuisine === r[1];
      if ((r = c.match(/^restaurant_id:"(.+)"$/))) return m.restaurantId === r[1];
      if ((r = c.match(/^(\w+) (<=|>=) (\d+)$/))) return r[2] === "<=" ? num(m, r[1]) <= +r[3] : num(m, r[1]) >= +r[3];
      if (c === "is_sold_out:false") return !m.isSoldOut;
      if (c === "allergen_data_complete:true") return m.allergenDataComplete;
      return true;
    });
  const zones = await restaurantZones();
  const tokens = query.split(/\s+/).filter(Boolean);
  const text = (m: MenuItem) => [m.name, m.description, m.restaurantName, ...m.tasteTags.map((t) => TAG_WORDS[t] ?? ""), TAG_WORDS[m.category ?? ""] ?? ""].join(" ");
  const scored = items
    .filter((m) => pass(m, (z) => (zones[m.restaurantId] ?? []).includes(z)))
    .map((m) => ({ m, score: tokens.filter((t) => text(m).includes(t)).length }))
    .sort((a, b) => b.score - a.score);
  const matched = scored.some((s) => s.score > 0) ? scored.filter((s) => s.score > 0) : scored; // like optional words
  const dishMatch = (m: MenuItem) => tokens.some((t) => `${m.name} ${m.description}`.includes(t));
  return matched.slice(0, limit).map(({ m }) => ({
    ...toSearchHit(m, zones[m.restaurantId] ?? []),
    _highlightResult: { name: { matchLevel: dishMatch(m) ? "partial" : "none" }, description: { matchLevel: "none" } },
  }));
}

export function toSearchHit(m: MenuItem, zones: string[]) {
  return {
    objectID: m.itemId,
    name: m.name,
    description: m.description,
    restaurant_id: m.restaurantId,
    restaurant_name: m.restaurantName,
    price_incl_tax: m.priceInclTax,
    tax_category: m.taxCategory,
    category: m.category ?? "",
    cuisine: m.cuisine ?? "",
    serving_temp: m.servingTemp,
    allergens: m.allergens,
    allergen_data_complete: m.allergenDataComplete,
    dietary_tags: m.dietary,
    taste_tags: m.tasteTags,
    calories: m.calories ?? undefined,
    delivery_area_codes: zones,
    serving_from_min: m.servingFromMin,
    serving_to_min: m.servingToMin,
    is_sold_out: m.isSoldOut,
  };
}

export async function restaurantZones(): Promise<Record<string, string[]>> {
  const { rows } = await db.query<{ restaurant_id: string; zone_codes: string[] }>("SELECT restaurant_id, zone_codes FROM restaurants WHERE is_active");
  return Object.fromEntries(rows.map((r) => [r.restaurant_id, r.zone_codes]));
}

/** All menu items as search records (used to sync Algolia from the database). */
export async function allSearchRecords() {
  const zones = await restaurantZones();
  const { rows } = await db.query(SELECT_ITEMS);
  return rows.map(mapItem).map((m) => toSearchHit(m, zones[m.restaurantId] ?? []));
}

const CATEGORY_ORDER = ["sushi", "tempura", "noodles", "rice", "curry", "bento", "salad", "soup", "side", "dessert", "drink"];

/** Menu for the home page, grouped by category (public data only). */
export async function listMenuByCategory() {
  const { rows } = await db.query(`${SELECT_ITEMS} ORDER BY m.category, m.price_incl_tax`);
  const items = rows.map(mapItem);
  const groups = new Map<string, ReturnType<typeof publicItem>[]>();
  for (const m of items) {
    const key = m.category ?? "other";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(publicItem(m));
  }
  const rank = (c: string) => (CATEGORY_ORDER.indexOf(c) + 1 || 99);
  return [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0])).map(([category, list]) => ({ category, items: list }));
}

function publicItem(m: MenuItem) {
  return {
    itemId: m.itemId, name: m.name, description: m.description, restaurant: m.restaurantName, priceInclTax: m.priceInclTax,
    allergens: m.allergens, dietary: m.dietary, tasteTags: m.tasteTags, calories: m.calories, isSoldOut: m.isSoldOut,
    servingTemp: m.servingTemp, cuisine: m.cuisine, servingFromMin: m.servingFromMin, servingToMin: m.servingToMin,
  };
}
