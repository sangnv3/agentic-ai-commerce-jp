/**
 * Upsert the sample restaurants and menu (src/db/sampleData.ts). Idempotent: content is updated, stock is only
 * changed when given. Called on startup when SEED_SAMPLE_DATA=true, and by `npm run seed` / `npm run dev:seed`.
 */
import { MENU } from "./sampleData.js";
import { ITEM_EN, OPTION_EN, RESTAURANT_EN } from "./sampleDataEn.js";
import { DELIVERY_ZONES } from "../commerce/settings.js";
import { db } from "./pool.js";

export async function seedSampleData(stockArgs: Map<string, number> = new Map(), log: (msg: string) => void = console.log) {
  const zones = [...new Set(Object.values(DELIVERY_ZONES).map((z) => z.zone))];
  const restaurants = new Map(MENU.map((m) => [m.restaurant_id, m.restaurant_name]));
  const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

  let n = 0;
  for (const [id, name] of restaurants) {
    await db.query(
      `INSERT INTO restaurants (restaurant_id, name_ja, name_en, qualified_invoice_reg_no, min_prep_minutes, opening_hours, zone_codes)
       VALUES ($1,$2,$5,$3,45,'{}',$4)
       ON CONFLICT (restaurant_id) DO UPDATE SET name_ja = EXCLUDED.name_ja, name_en = EXCLUDED.name_en, zone_codes = EXCLUDED.zone_codes`,
      [id, name, `T${String(1000000000000 + ++n).slice(0, 13)}`, zones, RESTAURANT_EN[id] ?? null],
    );
  }
  for (const m of MENU) {
    await db.query(
      `INSERT INTO menu_items (item_id, restaurant_id, name_ja, description_ja, price_incl_tax, tax_category, allergens, allergen_data_complete,
         dietary_tags, taste_tags, category, cuisine, serving_temp, calories, daily_stock, available_from, available_to, name_en, description_en)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NULL,$15,$16,$17,$18)
       ON CONFLICT (item_id) DO UPDATE SET name_ja = EXCLUDED.name_ja, description_ja = EXCLUDED.description_ja, price_incl_tax = EXCLUDED.price_incl_tax,
         name_en = EXCLUDED.name_en, description_en = EXCLUDED.description_en,
         tax_category = EXCLUDED.tax_category, allergens = EXCLUDED.allergens, allergen_data_complete = EXCLUDED.allergen_data_complete,
         dietary_tags = EXCLUDED.dietary_tags, taste_tags = EXCLUDED.taste_tags, category = EXCLUDED.category, cuisine = EXCLUDED.cuisine,
         serving_temp = EXCLUDED.serving_temp, calories = EXCLUDED.calories, available_from = EXCLUDED.available_from,
         available_to = EXCLUDED.available_to, updated_at = now()`,
      [m.item_id, m.restaurant_id, m.name, m.description, m.price_incl_tax, m.tax_category, m.allergens, m.allergen_data_complete,
        m.dietary_tags, m.taste_tags, m.category, m.cuisine, m.serving_temp, m.calories, hhmm(m.serving_from_min), hhmm(m.serving_to_min),
        ITEM_EN[m.item_id]?.[0] ?? null, ITEM_EN[m.item_id]?.[1] ?? null],
    );
    await db.query("DELETE FROM menu_item_options WHERE item_id = $1", [m.item_id]);
    for (const [k, g] of m.options.entries()) {
      const choices = g.options.map((o) => ({ ...o, nameEn: OPTION_EN[`${g.id}.${o.id}`] }));
      await db.query(
        "INSERT INTO menu_item_options (option_group_id, item_id, name_ja, name_en, required, options, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [g.id, m.item_id, g.name, OPTION_EN[g.id] ?? null, g.required, JSON.stringify(choices), k],
      );
    }
  }
  for (const [itemId, stock] of stockArgs) {
    await db.query("UPDATE menu_items SET daily_stock = $2, is_sold_out = false WHERE item_id = $1", [itemId, stock]);
    console.log(`[seed] stock ${itemId} = ${stock}`);
  }
  log(`[seed] ${restaurants.size} restaurants, ${MENU.length} menu items (unlimited stock unless --stock)`);
}
