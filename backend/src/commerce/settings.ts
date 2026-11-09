/**
 * Business settings for the ordering domain. Defaults match the sample data; override with env vars.
 */
const env = (k: string, d: string) => process.env[k] ?? d;

/** Delivery area: postal-code prefix (first 3 digits) → zone + delivery fee (JPY, tax incl., 10% rate). */
export const DELIVERY_ZONES: Record<string, { zone: string; fee: number }> = JSON.parse(
  env(
    "DELIVERY_ZONES_JSON",
    JSON.stringify({
      "150": { zone: "SHIBUYA-A", fee: 330 },
      "151": { zone: "SHIBUYA-A", fee: 330 },
      "153": { zone: "MEGURO-A", fee: 350 },
      "154": { zone: "SETAGAYA-B", fee: 380 },
      "106": { zone: "MINATO-A", fee: 350 },
      "107": { zone: "MINATO-A", fee: 350 },
    }),
  ),
);

export const SLOTS = {
  /** 30-minute slots offered each day (JST). */
  times: ["11:00", "11:30", "12:00", "12:30", "13:00", "13:30", "18:00", "18:30", "19:00", "19:30", "20:00"],
  lunchCutoff: env("ORDER_CUTOFF_LUNCH", "10:30"), // for slots up to 14:00
  dinnerCutoff: env("ORDER_CUTOFF_DINNER", "16:30"),
  minPrepMinutes: Number(env("MIN_PREP_MINUTES", "45")),
  defaultCapacity: Number(env("SLOT_CAPACITY", "20")),
  /** false = ignore cutoff / prep time (handy for local testing at any hour). */
  strictTime: env("SLOT_RULES_STRICT", "true") === "true",
  /** Slots that are always full — a test lever for the "slot full" branch (e.g. "12:30"). */
  forcedFull: new Set(env("DEMO_FULL_SLOTS", "").split(",").map((s) => s.trim()).filter(Boolean)),
};

/**
 * Approximate exchange rates (JPY per 1 unit) so the agent can understand budgets like "$5" or "50k VND".
 * All prices and payments stay in JPY. Override with FX_JPY_PER_UNIT_JSON.
 */
export const FX_JPY_PER_UNIT: Record<string, number> = JSON.parse(env("FX_JPY_PER_UNIT_JSON", JSON.stringify({ USD: 150, EUR: 162, VND: 0.0058 })));

/** Qualified invoice issuer (適格請求書発行事業者). */
export const INVOICE_ISSUER = {
  name: env("INVOICE_ISSUER_NAME", "株式会社サンプルフード"),
  regNo: env("INVOICE_ISSUER_REG_NO", "T1234567890123"),
};

/** Coupons (code → rule). The agent can only apply codes defined here; auto picks the best eligible one. */
export const COUPONS: Record<string, { minSubtotal: number; discount: number; label: string }> = {
  LUNCH100: { minSubtotal: 1000, discount: 100, label: "クーポン LUNCH100" },
};
