import { algoliasearch } from "algoliasearch";
import { config } from "../config.js";
import { wrapUntrusted } from "../agent/sanitize.js";
import { localSearch } from "../commerce/catalog.js";

/** Shape of an Algolia record in menu_items_{ja,en} (docs/07 §7.2). */
export interface MenuHit {
  objectID: string;
  name: string;
  name_en?: string;
  description?: string;
  restaurant_id: string;
  restaurant_name: string;
  restaurant_name_en?: string;
  price_incl_tax: number;
  tax_category: "reduced_8" | "standard_10";
  category: string;
  cuisine: string;
  allergens: string[];
  allergen_data_complete: boolean;
  dietary_tags: string[];
  taste_tags: string[];
  calories?: number;
  image_url?: string;
  popularity?: number;
  /** Algolia highlight info, used to tell whether the dish itself (name/description) matched the query. */
  _highlightResult?: Record<string, { matchLevel?: string }>;
}

export interface HardConstraints {
  allergens: string[]; // saved + today's extra
  dietary: string[]; // required tags, e.g. halal
  zone: string;
  slotMinutes: number; // delivery slot start, minutes since 00:00 JST (e.g. 12:00 → 720)
  maxPrice?: number;
  requireCompleteAllergenData: boolean;
}

export interface SoftProfile {
  likedItems: Record<string, number>; // item_id -> decayed weight [-1,1]
  favoriteRestaurants: Record<string, number>;
  cuisines: Record<string, number>;
  taste: Record<string, number>; // e.g. { spicy: -0.6, oily: -0.4 }
  priceRange?: { p25: number; p75: number };
  recentlyEaten: string[]; // item ids in the last 2 days
  /** Entered by the customer on the preferences screen. */
  statedTasteLike: string[];
  statedTasteAvoid: string[];
  /** Foods the customer likes / wants to avoid, as words to look for in the dish name and description. */
  preferKeywords: string[];
  avoidKeywords: string[];
}

export interface TodayIntent {
  tasteTagsAny: string[];
  category?: string;
  cuisine?: string;
  servingTemp?: string;
}

let algolia: ReturnType<typeof algoliasearch> | undefined;

/** Algolia search; without ALGOLIA_APP_ID the same filters are evaluated over the menu table (local dev). */
async function searchIndex(locale: "ja" | "en", query: string, filters: string): Promise<MenuHit[]> {
  if (!config.algolia.appId) return (await localSearch(query, filters, 30)) as MenuHit[];
  algolia ??= algoliasearch(config.algolia.appId, config.algolia.searchKey);
  const res = await algolia.searchSingleIndex<MenuHit>({
    indexName: config.algolia.indexByLocale[locale],
    searchParams: { query, filters, hitsPerPage: 30, attributesToHighlight: ["name", "description"] },
  });
  return res.hits;
}

/** Escape a value for an Algolia filter string. */
const q = (v: string) => `"${v.replace(/"/g, '\\"')}"`;

/**
 * Hard constraints are built HERE from the user's profile and the server-side slot/zone,
 * never from LLM input alone. The LLM can only make filters stricter, never looser.
 */
export function buildFilters(hard: HardConstraints, extra: { category?: string; cuisine?: string; restaurantId?: string; minPrice?: number; maxCalories?: number }): string {
  const parts: string[] = [
    ...hard.allergens.map((a) => `NOT allergens:${q(a)}`),
    ...hard.dietary.map((d) => `dietary_tags:${q(d)}`),
    `delivery_area_codes:${q(hard.zone)}`,
    // Served at that time of day. Real-time stock/capacity is NOT indexed (it changes too often):
    // it is checked server-side by check_inventory / add_to_cart / execute_payment.
    `serving_from_min <= ${Math.floor(hard.slotMinutes)}`,
    `serving_to_min >= ${Math.floor(hard.slotMinutes)}`,
    `is_sold_out:false`,
  ];
  if (hard.maxPrice !== undefined) parts.push(`price_incl_tax <= ${Math.floor(hard.maxPrice)}`);
  if (extra.minPrice !== undefined) parts.push(`price_incl_tax >= ${Math.floor(extra.minPrice)}`);
  if (extra.maxCalories !== undefined) parts.push(`calories <= ${Math.floor(extra.maxCalories)}`);
  if (hard.requireCompleteAllergenData) parts.push("allergen_data_complete:true");
  if (extra.category) parts.push(`category:${q(extra.category)}`);
  if (extra.cuisine) parts.push(`cuisine:${q(extra.cuisine)}`);
  if (extra.restaurantId) parts.push(`restaurant_id:${q(extra.restaurantId)}`);
  return parts.join(" AND ");
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

function personalScore(hit: MenuHit, soft: SoftProfile, today: TodayIntent): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let x = 0;
  const liked = soft.likedItems[hit.objectID] ?? 0;
  if (liked > 0.5) reasons.push("previously_liked");
  if (liked < -0.3) reasons.push("previously_disliked");
  x += 2.0 * liked;

  const fav = soft.favoriteRestaurants[hit.restaurant_id] ?? 0;
  if (fav > 0.5) reasons.push("favorite_restaurant");
  x += 1.0 * fav;
  x += 0.6 * (soft.cuisines[hit.cuisine] ?? 0);

  // Long-term taste only on dimensions today's request does not already decide.
  const todayDecides = new Set(today.tasteTagsAny);
  if (!todayDecides.has("spicy") && !todayDecides.has("mild") && hit.taste_tags.includes("spicy")) x += 0.8 * (soft.taste.spicy ?? 0);
  if (!todayDecides.has("low_oil") && !todayDecides.has("hearty") && hit.taste_tags.includes("hearty")) x += 0.5 * (soft.taste.oily ?? 0);

  if (soft.priceRange) {
    const { p25, p75 } = soft.priceRange;
    const p = hit.price_incl_tax;
    const fit = p >= p25 && p <= p75 ? 1 : Math.max(0, 1 - Math.min(Math.abs(p - p25), Math.abs(p - p75)) / 1000);
    if (fit === 1) reasons.push("usual_price_range");
    x += 0.5 * fit;
  }
  if (soft.recentlyEaten.includes(hit.objectID)) x -= 0.6; // avoid monotony

  // The customer's own statements. Taste tags today's request already decides are left to todayMatch.
  const likedTags = soft.statedTasteLike.filter((t) => !todayDecides.has(t) && hit.taste_tags.includes(t));
  const avoidedTags = soft.statedTasteAvoid.filter((t) => !todayDecides.has(t) && hit.taste_tags.includes(t));
  if (likedTags.length) {
    x += Math.min(1.2, 0.6 * likedTags.length);
    reasons.push(...likedTags.map((t) => `stated_taste:${t}`));
  }
  if (avoidedTags.length) {
    x -= 1.5;
    reasons.push(...avoidedTags.map((t) => `stated_taste_avoid:${t}`));
  }
  const favFoods = preferenceHits(hit, soft.preferKeywords);
  if (favFoods.length) {
    x += 1.5;
    reasons.push(...favFoods.map((k) => `stated_favorite:${k}`));
  }
  return { score: sigmoid(x), reasons };
}

const norm = (v: string) => v.normalize("NFKC").toLowerCase();

/** Which of the keywords appear in the dish name or description (case/width-insensitive). */
export function preferenceHits(hit: Pick<MenuHit, "name" | "description">, keywords: string[]): string[] {
  const text = norm(`${hit.name} ${hit.description ?? ""}`);
  return keywords.filter((k) => k.trim() && text.includes(norm(k.trim())));
}

function todayMatch(hit: MenuHit, today: TodayIntent): { score: number; reasons: string[] } {
  if (today.tasteTagsAny.length === 0) return { score: 0.5, reasons: [] };
  const matched = today.tasteTagsAny.filter((t) => hit.taste_tags.includes(t));
  return { score: matched.length / today.tasteTagsAny.length, reasons: matched.map((t) => `${t}_tag`) };
}

export interface RankedItem {
  item_id: string;
  name: string;
  /** English display name, only for an English-speaking customer (so Claude names the dish like the card does). */
  name_en?: string;
  restaurant: { restaurant_id: string; name: string; name_en?: string };
  price_incl_tax: number;
  tax_category: string;
  allergens: string[];
  calories?: number;
  tags: string[];
  image_url?: string;
  description: string;
  score: { final: number; relevance: number; personal: number; today: number };
  match_reasons: string[];
  /** Foods from the customer's avoid list found in this dish. Non-empty = do not pick it unless asked for. */
  preference_conflicts: string[];
  /** false = the item matches the filters (budget, allergens…) but none of the requested words. */
  query_match: boolean;
}

export async function searchAndRank(params: {
  locale: "ja" | "en";
  query: string;
  filters: string;
  soft: SoftProfile;
  today: TodayIntent;
  limit: number;
  /** Re-read allergens from the DB (source of truth) for the final candidates. */
  verifyAllergens: (itemIds: string[]) => Promise<Record<string, string[]>>;
  forbiddenAllergens: string[];
}): Promise<{ results: RankedItem[]; dropped: number }> {
  const hits = await searchIndex(params.locale, params.query, params.filters);

  // An avoided food the customer asks for today ("wasabi sushi") is not held against the results.
  const avoid = params.soft.avoidKeywords.filter((k) => !norm(params.query).includes(norm(k)));

  const scored = hits.map((hit, idx) => {
    // Fixed 30-position window (docs/06 §6.4): with few hits, normalizing by hits.length would make each
    // Algolia position worth a lot and drown out personalization.
    const relevance = 1 - idx / 30;
    const p = personalScore(hit, params.soft, params.today);
    const t = todayMatch(hit, params.today);
    const conflicts = preferenceHits(hit, avoid);
    // Strong demotion: an item with a food the customer said they avoid should not be the default pick.
    const final = 0.45 * relevance + 0.35 * p.score + 0.2 * t.score - (conflicts.length ? 0.35 : 0);
    const reasons = [...p.reasons, ...t.reasons];
    if (params.filters.includes("price_incl_tax <=")) reasons.push("within_budget");
    return { hit, relevance, personal: p.score, today: t.score, final, reasons, conflicts };
  });
  scored.sort((a, b) => b.final - a.final);

  // Diversity: at most 4 items per restaurant (a "sushi" query legitimately comes from one sushi shop).
  const perRestaurant = new Map<string, number>();
  const diversified = scored.filter((s) => {
    const n = perRestaurant.get(s.hit.restaurant_id) ?? 0;
    if (n >= 4) return false;
    perRestaurant.set(s.hit.restaurant_id, n + 1);
    return true;
  });

  // Post-check allergens against the DB: the index may lag behind.
  const candidates = diversified.slice(0, params.limit * 2);
  const truth = await params.verifyAllergens(candidates.map((c) => c.hit.objectID));
  const forbidden = new Set(params.forbiddenAllergens);
  const safe = candidates.filter((c) => {
    const allergens = truth[c.hit.objectID];
    return allergens !== undefined && !allergens.some((a) => forbidden.has(a));
  });

  const en = params.locale === "en";
  const results: RankedItem[] = safe.slice(0, params.limit).map((c) => ({
    item_id: c.hit.objectID,
    name: wrapUntrusted(c.hit.name, 80),
    ...(en && c.hit.name_en ? { name_en: wrapUntrusted(c.hit.name_en, 80) } : {}),
    restaurant: {
      restaurant_id: c.hit.restaurant_id,
      name: wrapUntrusted(c.hit.restaurant_name, 60),
      ...(en && c.hit.restaurant_name_en ? { name_en: wrapUntrusted(c.hit.restaurant_name_en, 60) } : {}),
    },
    price_incl_tax: c.hit.price_incl_tax,
    tax_category: c.hit.tax_category,
    allergens: truth[c.hit.objectID],
    calories: c.hit.calories,
    tags: c.hit.taste_tags,
    image_url: c.hit.image_url,
    description: wrapUntrusted(c.hit.description, 200),
    score: {
      final: +c.final.toFixed(3),
      relevance: +c.relevance.toFixed(3),
      personal: +c.personal.toFixed(3),
      today: +c.today.toFixed(3),
    },
    match_reasons: [...new Set(c.reasons)],
    preference_conflicts: c.conflicts,
    // A match on the restaurant name alone (e.g. "寿司" in 寿司 匠 for a miso soup) does not count.
    query_match:
      params.query.trim() === "" ||
      ["name", "description"].some((k) => (c.hit._highlightResult?.[k]?.matchLevel ?? "full") !== "none"),
  }));
  return { results, dropped: candidates.length - safe.length };
}
