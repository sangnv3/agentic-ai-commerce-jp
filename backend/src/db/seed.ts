/**
 * Seed the sample restaurants and menu (src/db/sampleData.ts) into PostgreSQL. Idempotent: content is
 * upserted, stock is only set on first insert (unless --stock is given).
 *   npm run db:seed                         # after db:migrate
 *   npm run db:seed -- --stock itm_1021=0   # e.g. make 鶏むね肉と温野菜の蒸し定食 sold out to test re-planning
 */
import { MENU } from "./sampleData.js";

// Production with a real menu: leave SEED_SAMPLE_DATA unset (the pre-deploy step then skips seeding).
if (process.env.SEED_SAMPLE_DATA !== "true" && process.env.NODE_ENV === "production") {
  console.log("[seed] skipped (set SEED_SAMPLE_DATA=true to load the sample restaurants and menu)");
  process.exit(0);
}
import { DELIVERY_ZONES } from "../commerce/settings.js";
import { db } from "./pool.js";

const zones = [...new Set(Object.values(DELIVERY_ZONES).map((z) => z.zone))];
const restaurants = new Map(MENU.map((m) => [m.restaurant_id, m.restaurant_name]));
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

const stockArgs = new Map<string, number>();
const i = process.argv.indexOf("--stock");
if (i > 0) for (const kv of (process.argv[i + 1] ?? "").split(",")) { const [k, v] = kv.split("="); if (k && v !== undefined) stockArgs.set(k, Number(v)); }

let n = 0;
for (const [id, name] of restaurants) {
  await db.query(
    `INSERT INTO restaurants (restaurant_id, name_ja, qualified_invoice_reg_no, min_prep_minutes, opening_hours, zone_codes)
     VALUES ($1,$2,$3,45,'{}',$4)
     ON CONFLICT (restaurant_id) DO UPDATE SET name_ja = EXCLUDED.name_ja, zone_codes = EXCLUDED.zone_codes`,
    [id, name, `T${String(1000000000000 + ++n).slice(0, 13)}`, zones],
  );
}
for (const m of MENU) {
  await db.query(
    `INSERT INTO menu_items (item_id, restaurant_id, name_ja, description_ja, price_incl_tax, tax_category, allergens, allergen_data_complete,
       dietary_tags, taste_tags, category, cuisine, serving_temp, calories, daily_stock, available_from, available_to)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NULL,$15,$16)
     ON CONFLICT (item_id) DO UPDATE SET name_ja = EXCLUDED.name_ja, description_ja = EXCLUDED.description_ja, price_incl_tax = EXCLUDED.price_incl_tax,
       tax_category = EXCLUDED.tax_category, allergens = EXCLUDED.allergens, allergen_data_complete = EXCLUDED.allergen_data_complete,
       dietary_tags = EXCLUDED.dietary_tags, taste_tags = EXCLUDED.taste_tags, category = EXCLUDED.category, cuisine = EXCLUDED.cuisine,
       serving_temp = EXCLUDED.serving_temp, calories = EXCLUDED.calories, available_from = EXCLUDED.available_from,
       available_to = EXCLUDED.available_to, updated_at = now()`,
    [m.item_id, m.restaurant_id, m.name, m.description, m.price_incl_tax, m.tax_category, m.allergens, m.allergen_data_complete,
      m.dietary_tags, m.taste_tags, m.category, m.cuisine, m.serving_temp, m.calories, hhmm(m.serving_from_min), hhmm(m.serving_to_min)],
  );
  await db.query("DELETE FROM menu_item_options WHERE item_id = $1", [m.item_id]);
  for (const [k, g] of m.options.entries()) {
    await db.query(
      "INSERT INTO menu_item_options (option_group_id, item_id, name_ja, required, options, sort_order) VALUES ($1,$2,$3,$4,$5,$6)",
      [g.id, m.item_id, g.name, g.required, JSON.stringify(g.options), k],
    );
  }
}
for (const [itemId, stock] of stockArgs) {
  await db.query("UPDATE menu_items SET daily_stock = $2, is_sold_out = false WHERE item_id = $1", [itemId, stock]);
  console.log(`[seed] stock ${itemId} = ${stock}`);
}
console.log(`[seed] ${restaurants.size} restaurants, ${MENU.length} menu items (unlimited stock unless --stock)`);
await db.end();
