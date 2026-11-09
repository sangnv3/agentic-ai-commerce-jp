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

export async function getPreferences(userId: string) {
  const p = await profileRow(userId);
  const s = p.soft ?? {};
  const recent = await db.query<{ item_id: string }>(
    `SELECT DISTINCT l.item_id FROM order_lines l JOIN orders o USING (order_id)
      WHERE o.user_id = $1 AND o.created_at > now() - interval '2 days'`,
    [userId],
  );
  return {
    version: p.version as number,
    hard_constraints: { allergens: p.allergens as string[], dietary: p.dietary as string[] },
    soft: {
      price_range: s.price_range as { p25: number; p75: number } | undefined,
      liked_items: (s.liked_items ?? []) as WeightedItem[],
      disliked_items: (s.disliked_items ?? []) as WeightedItem[],
      favorite_restaurants: (s.favorite_restaurants ?? []) as WeightedRestaurant[],
      taste: (s.taste ?? {}) as Record<string, number>,
      cuisines: (s.cuisines ?? {}) as Record<string, number>,
      recently_eaten: recent.rows.map((r) => r.item_id),
    },
  };
}

/** Compact view given to Claude at the start of a session (no email/phone/card data). */
export async function getAgentContext(userId: string) {
  const [profile, prefs] = await Promise.all([getProfile(userId), getPreferences(userId)]);
  return {
    family_name: profile.familyName,
    locale: profile.locale,
    habit: profile.habit,
    addresses: profile.addresses.map((a) => ({ id: a.id, label: a.label, short: `${a.city}${a.street} ${a.building}`.trim() })),
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
