import { randomUUID } from "node:crypto";
import { db, tx } from "../db/pool.js";
import { CommerceError } from "./errors.js";
import { USER as TEMPLATE } from "../db/sampleData.js";

export type AuthProvider = "entra" | "demo" | "dev";

/**
 * Find or create the internal user for a login identity. Demo and dev users start as a copy of the sample
 * customer (addresses, payment methods, preferences) so the agent has something to personalize with.
 * Real Entra users start empty: the agent asks for address and preferences.
 */
export async function ensureUser(args: {
  externalId: string;
  provider: AuthProvider;
  displayName?: string;
  email?: string;
  entraOid?: string;
  entraTid?: string;
}): Promise<string> {
  const existing = await db.query<{ user_id: string }>("SELECT user_id FROM users WHERE external_id = $1", [args.externalId]);
  if (existing.rows[0]) return existing.rows[0].user_id;

  const withTemplate = args.provider !== "entra";
  return tx(async (c) => {
    const ins = await c.query<{ user_id: string }>(
      `INSERT INTO users (external_id, auth_provider, entra_oid, entra_tid, display_name, family_name, email, locale, personalization_consent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'ja-JP',$8)
       ON CONFLICT (external_id) DO UPDATE SET updated_at = now()
       RETURNING user_id`,
      [
        args.externalId,
        args.provider,
        args.entraOid ?? null,
        args.entraTid ?? null,
        args.displayName ?? (withTemplate ? TEMPLATE.displayName : "お客様"),
        withTemplate ? TEMPLATE.familyName : null,
        args.email ?? (withTemplate ? TEMPLATE.email : null),
        withTemplate,
      ],
    );
    const userId = ins.rows[0].user_id;
    if (withTemplate) {
      for (const a of TEMPLATE.addresses) {
        await c.query(
          `INSERT INTO addresses (address_id, user_id, label, postal_code, prefecture, city, street, building, zone_code, is_default)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
          [`addr_${a.label}_${userId.slice(0, 8)}`, userId, a.label, a.postalCode, a.prefecture, a.city, a.street, a.building, a.zoneCode, a.isDefault],
        );
      }
      for (const p of TEMPLATE.paymentMethods) {
        await c.query(
          `INSERT INTO payment_methods (payment_method_id, user_id, type, psp_token, brand, last4, is_default)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
          [`pm_${p.type}_${userId.slice(0, 8)}`, userId, p.type, `demo_tok_${randomUUID()}`, p.brand, p.last4, p.isDefault],
        );
      }
      const pr = TEMPLATE.preferences;
      await c.query(
        `INSERT INTO preference_profiles (user_id, allergens, dietary, soft) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [userId, pr.allergens, pr.dietary, JSON.stringify({
          liked_items: pr.liked_items, disliked_items: pr.disliked_items, favorite_restaurants: pr.favorite_restaurants,
          taste: pr.taste, cuisines: pr.cuisines, price_range: pr.price_range,
          habit: TEMPLATE.habit, recent_orders: TEMPLATE.recentOrders,
        })],
      );
    } else {
      await c.query("INSERT INTO preference_profiles (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [userId]);
    }
    return userId;
  });
}

const paymentLabel = (p: { type: string; brand: string | null; last4: string | null }) =>
  p.type === "card" ? `${p.brand ?? "CARD"} **** ${p.last4}` : p.type === "paypay" ? "PayPay" : p.type;

export async function getAddresses(userId: string) {
  const { rows } = await db.query(
    "SELECT * FROM addresses WHERE user_id = $1 AND deleted_at IS NULL ORDER BY is_default DESC, label",
    [userId],
  );
  return rows.map((a) => ({
    id: a.address_id as string,
    label: a.label as string,
    postalCode: (a.postal_code as string).trim(),
    prefecture: a.prefecture as string,
    city: a.city as string,
    street: a.street as string,
    building: (a.building as string | null) ?? "",
    zoneCode: a.zone_code as string | null,
    isDefault: a.is_default as boolean,
  }));
}

export async function getPaymentMethods(userId: string) {
  const { rows } = await db.query("SELECT * FROM payment_methods WHERE user_id = $1 ORDER BY is_default DESC", [userId]);
  return rows.map((p) => ({ id: p.payment_method_id as string, type: p.type as string, label: paymentLabel(p), isDefault: p.is_default as boolean }));
}

async function profileRow(userId: string) {
  const { rows } = await db.query(
    `SELECT u.display_name, u.family_name, u.locale, p.allergens, p.dietary, p.soft, p.version
       FROM users u JOIN preference_profiles p USING (user_id) WHERE u.user_id = $1`,
    [userId],
  );
  if (!rows[0]) throw new CommerceError("NOT_FOUND", "user not found");
  return rows[0];
}

async function recentOrders(userId: string) {
  const { rows } = await db.query(
    `SELECT o.order_id, to_char(o.delivery_slot_start AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') AS slot, o.total,
            (SELECT array_agg(name_snapshot ORDER BY line_no) FROM order_lines l WHERE l.order_id = o.order_id) AS items
       FROM orders o WHERE o.user_id = $1 ORDER BY o.created_at DESC LIMIT 10`,
    [userId],
  );
  return rows;
}

export async function getProfile(userId: string) {
  const p = await profileRow(userId);
  return {
    displayName: p.display_name,
    familyName: p.family_name,
    locale: p.locale,
    addresses: await getAddresses(userId),
    paymentMethods: await getPaymentMethods(userId),
    habit: p.soft.habit ?? null,
    recentOrders: [...(await recentOrders(userId)), ...(p.soft.recent_orders ?? [])].slice(0, 10),
  };
}

interface WeightedItem { item_id: string; name: string; weight: number; reason?: string }
interface WeightedRestaurant { restaurant_id: string; weight: number }

/** Vocabularies shared with the search index (taste_tags, cuisine, dietary_tags). */
export const TASTE_TAGS = ["light", "low_oil", "hearty", "spicy", "mild", "high_protein", "low_calorie", "low_carb", "vegetable_rich"] as const;
export const CUISINES = ["japanese", "chinese", "korean", "western", "italian", "ethnic"] as const;
export const DIETARY = ["vegetarian", "vegan", "halal", "low_carb", "gluten_free"] as const;

/**
 * Preferences the customer typed in on the "My preferences" screen. Soft: they steer search ranking and the
 * agent's choice; only allergens/dietary (stored separately) are hard constraints.
 */
export interface StatedPreferences {
  favorite_foods: string[]; // free text, any language: "サーモン", "salmon", "cá hồi"
  avoid_foods: string[]; // free text: "わさび", "raw onion"
  taste_like: string[]; // TASTE_TAGS
  taste_avoid: string[]; // TASTE_TAGS
  cuisines: string[]; // CUISINES
  budget_per_person: number | null; // JPY, tax incl.
  note: string; // free text, e.g. "量は少なめが好き"
  updated_at: string | null;
}

const EMPTY_STATED: StatedPreferences = {
  favorite_foods: [], avoid_foods: [], taste_like: [], taste_avoid: [], cuisines: [], budget_per_person: null, note: "", updated_at: null,
};

function readStated(soft: Record<string, unknown>): StatedPreferences {
  return { ...EMPTY_STATED, ...((soft.stated as Partial<StatedPreferences> | undefined) ?? {}) };
}

const hasStated = (s: StatedPreferences) =>
  s.favorite_foods.length + s.avoid_foods.length + s.taste_like.length + s.taste_avoid.length + s.cuisines.length > 0 ||
  s.budget_per_person !== null || s.note !== "";

/** Learned cuisine/taste weights with the customer's own statements on top (a statement beats a learned signal). */
function mergeStated(learned: { taste: Record<string, number>; cuisines: Record<string, number> }, s: StatedPreferences) {
  const cuisines = { ...learned.cuisines };
  for (const c of s.cuisines) cuisines[c] = Math.max(cuisines[c] ?? 0, 0.8);
  const taste = { ...learned.taste };
  // The ranker reads taste.spicy and taste.oily; the other tags are scored directly from taste_like/taste_avoid.
  if (s.taste_like.includes("spicy")) taste.spicy = 0.8;
  if (s.taste_avoid.includes("spicy")) taste.spicy = -0.9;
  if (s.taste_like.includes("hearty")) taste.oily = 0.6;
  if (s.taste_avoid.includes("hearty") || s.taste_like.includes("low_oil")) taste.oily = -0.6;
  return { cuisines, taste };
}

export async function getPreferences(userId: string) {
  const p = await profileRow(userId);
  const s = p.soft ?? {};
  const recent = await db.query<{ item_id: string }>(
    `SELECT DISTINCT l.item_id FROM order_lines l JOIN orders o USING (order_id)
      WHERE o.user_id = $1 AND o.created_at > now() - interval '2 days'`,
    [userId],
  );
  const stated = readStated(s);
  const merged = mergeStated({ taste: s.taste ?? {}, cuisines: s.cuisines ?? {} }, stated);
  return {
    version: p.version as number,
    hard_constraints: { allergens: p.allergens as string[], dietary: p.dietary as string[] },
    soft: {
      price_range: s.price_range as { p25: number; p75: number } | undefined,
      liked_items: (s.liked_items ?? []) as WeightedItem[],
      disliked_items: (s.disliked_items ?? []) as WeightedItem[],
      favorite_restaurants: (s.favorite_restaurants ?? []) as WeightedRestaurant[],
      taste: merged.taste,
      cuisines: merged.cuisines,
      recently_eaten: recent.rows.map((r) => r.item_id),
    },
    /** What the customer entered on the preferences screen (soft, but takes priority over learned signals). */
    stated,
  };
}

/** Allergen/dietary changes requested in chat, waiting for the customer to confirm on the preferences screen. */
export async function getPendingPreferenceChanges(userId: string) {
  const { rows } = await db.query<{ event_id: string; kind: string; subject_id: string | null; user_quote: string | null; created_at: Date }>(
    `SELECT event_id, kind, subject_id, user_quote, created_at FROM preference_events
      WHERE user_id = $1 AND status = 'pending_user_confirmation' ORDER BY created_at DESC LIMIT 20`,
    [userId],
  );
  return rows.map((r) => ({ id: `pe_${r.event_id}`, kind: r.kind, subject: r.subject_id, quote: r.user_quote, created_at: r.created_at }));
}

/**
 * Save the preferences screen. The customer edits their own allergens/dietary here (the confirmation step for
 * changes requested in chat), so they are applied directly; pending chat requests are resolved against the result.
 */
export async function savePreferenceSettings(
  userId: string,
  input: { allergens: string[]; dietary: string[]; stated: Omit<StatedPreferences, "updated_at"> },
) {
  const stated: StatedPreferences = { ...input.stated, updated_at: new Date().toISOString() };
  return tx(async (c) => {
    const { rows } = await c.query<{ version: number }>(
      `UPDATE preference_profiles
          SET allergens = $2, dietary = $3, soft = jsonb_set(soft, '{stated}', $4::jsonb, true),
              version = version + 1, recomputed_at = now()
        WHERE user_id = $1 RETURNING version`,
      [userId, input.allergens, input.dietary, JSON.stringify(stated)],
    );
    if (!rows[0]) throw new CommerceError("NOT_FOUND", "user not found");

    // Pending allergen/dietary requests from chat: applied if the saved state now reflects them, else rejected.
    const pending = await c.query<{ event_id: string; kind: string; subject_id: string | null }>(
      "SELECT event_id, kind, subject_id FROM preference_events WHERE user_id = $1 AND status = 'pending_user_confirmation'",
      [userId],
    );
    for (const e of pending.rows) {
      const applied =
        e.kind === "allergen_add_request" ? input.allergens.includes(e.subject_id ?? "") :
        e.kind === "allergen_remove_request" ? !input.allergens.includes(e.subject_id ?? "") :
        e.kind === "dietary_change_request" ? input.dietary.includes(e.subject_id ?? "") : false;
      await c.query("UPDATE preference_events SET status = $2 WHERE event_id = $1", [e.event_id, applied ? "applied" : "rejected"]);
    }

    await c.query(
      `INSERT INTO preference_events (user_id, kind, subject_type, source, user_quote, status)
       VALUES ($1, 'settings_update', 'note', 'user_edit', $2, 'applied')`,
      [userId, JSON.stringify({ allergens: input.allergens, dietary: input.dietary, ...input.stated }).slice(0, 1000)],
    );
    return { version: rows[0].version, stated };
  });
}

/** Compact view given to Claude at the start of a session (no email/phone/card data). */
export async function getAgentContext(userId: string) {
  const [profile, prefs] = await Promise.all([getProfile(userId), getPreferences(userId)]);
  return {
    family_name: profile.familyName,
    locale: profile.locale,
    habit: profile.habit,
    // full: same format as the checkout summary's address_text, so the customer sees one consistent address.
    addresses: profile.addresses.map((a) => ({
      id: a.id, label: a.label, is_default: a.isDefault,
      full: `〒${a.postalCode} ${a.prefecture}${a.city}${a.street} ${a.building}`.trim(),
    })),
    default_payment: profile.paymentMethods.find((p) => p.isDefault)?.label ?? null,
    payment_methods: profile.paymentMethods.map((p) => ({ id: p.id, label: p.label })),
    preferences: {
      version: prefs.version,
      allergens: prefs.hard_constraints.allergens,
      dietary: prefs.hard_constraints.dietary,
      likes: prefs.soft.liked_items.map((i: { name: string; item_id: string }) => `${i.name} (${i.item_id})`),
      dislikes: prefs.soft.disliked_items.map((i: { name: string; reason?: string }) => `${i.name}${i.reason ? `: ${i.reason}` : ""}`),
      taste: prefs.soft.taste,
      price_range: prefs.soft.price_range ?? null,
      // Entered by the customer on the preferences screen. Absent = nothing entered.
      ...(hasStated(prefs.stated) ? { stated: { ...prefs.stated, updated_at: undefined } } : {}),
    },
    recent_orders: profile.recentOrders.slice(0, 3),
  };
}

/** Explicit preference from chat. Allergen/dietary changes stay pending until the customer confirms in Settings. */
export async function recordPreference(userId: string, input: Record<string, unknown> & { kind: string; user_quote: string }) {
  const pending = /allergen|dietary/.test(input.kind);
  const subjectType = input.allergen ? "allergen" : input.dietary ? "dietary" : input.item_id ? "item" : input.restaurant_id ? "restaurant" : input.dimension ? "taste" : "note";
  const subjectId = (input.allergen ?? input.dietary ?? input.item_id ?? input.restaurant_id ?? input.dimension ?? null) as string | null;
  const value = input.kind.startsWith("dislike") || input.direction === "-" ? -0.8 : input.stars ? (Number(input.stars) - 3) / 2 : 0.8;
  const { rows } = await db.query<{ event_id: string }>(
    `INSERT INTO preference_events (user_id, kind, subject_type, subject_id, value, source, user_quote, half_life_days, status)
     VALUES ($1,$2,$3,$4,$5,'chat',$6,$7,$8) RETURNING event_id`,
    [userId, input.kind, subjectType, subjectId, value, input.user_quote, pending ? null : 365, pending ? "pending_user_confirmation" : "applied"],
  );
  if (!pending) await db.query("UPDATE preference_profiles SET version = version + 1, recomputed_at = now() WHERE user_id = $1", [userId]);
  return { id: `pe_${rows[0].event_id}`, status: pending ? "pending_user_confirmation" : "applied" };
}

/** Signals extracted by Claude Haiku after an order/review (validated and capped here). */
export async function savePreferenceSignals(
  userId: string,
  source: "order" | "feedback",
  signals: { kind: string; subject_id: string | null; dimension: string | null; direction: string | null; strength: number; evidence: string }[],
) {
  for (const s of signals.slice(0, 10)) {
    const strength = Math.max(0, Math.min(1, s.strength));
    await db.query(
      `INSERT INTO preference_events (user_id, kind, subject_type, subject_id, value, source, user_quote, half_life_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [userId, s.kind, s.dimension ? "taste" : s.kind === "cuisine" ? "cuisine" : "item", s.dimension ?? s.subject_id, s.direction === "-" ? -strength : strength, source, s.evidence.slice(0, 200), source === "order" ? 90 : 180],
    );
  }
  await db.query("UPDATE preference_profiles SET version = version + 1, recomputed_at = now() WHERE user_id = $1", [userId]);
}

/** APPI: erase all preference data for the user (profile reset + event log). */
export async function deletePreferences(userId: string) {
  await tx(async (c) => {
    await c.query("DELETE FROM preference_events WHERE user_id = $1", [userId]);
    await c.query("UPDATE preference_profiles SET allergens = '{}', dietary = '{}', soft = '{}', version = version + 1 WHERE user_id = $1", [userId]);
  });
}
