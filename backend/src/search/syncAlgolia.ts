/**
 * Push the menu from PostgreSQL (source of truth) to Algolia, with the index settings the agent relies on.
 *   ALGOLIA_ADMIN_KEY=<Write API key> npm run algolia:sync
 * The Write key is only needed here: pass it on the command line (or as a one-off variable), never store it with
 * the app's runtime variables — the backend itself only uses the Search key.
 */
import { algoliasearch } from "algoliasearch";
import { allSearchRecords } from "../commerce/catalog.js";
import { db } from "../db/pool.js";

const appId = process.env.ALGOLIA_APP_ID;
const adminKey = process.env.ALGOLIA_ADMIN_KEY;
if (!appId || !adminKey) {
  console.error("Set ALGOLIA_APP_ID and ALGOLIA_ADMIN_KEY.");
  process.exit(1);
}
const client = algoliasearch(appId, adminKey);
console.log("[algolia] loading menu from PostgreSQL…");
const records = (await allSearchRecords()).map((r, i, all) => ({ ...r, popularity: Math.round((1 - i / all.length) * 100) / 100 }));

const SYNONYMS = [
  ["あっさり", "さっぱり", "ヘルシー", "軽め", "light"],
  ["麺", "うどん", "そば", "ラーメン", "noodles"],
  ["ご飯", "ごはん", "丼", "定食", "rice"],
  ["鶏", "鶏肉", "チキン", "chicken"],
  ["鮭", "さけ", "サーモン", "salmon"],
  ["海老", "えび", "エビ", "shrimp"],
  ["油少なめ", "油控えめ", "低脂肪", "low oil"],
];

console.log(`[algolia] ${records.length} records loaded`);
// Tasks on one index are applied by Algolia strictly in the order they are sent, so we enqueue settings →
// synonyms → clear → records without blocking on each one (on busy/free plans a task can take minutes to publish).
const pending: { indexName: string; taskID: number }[] = [];
for (const [indexName, langs] of [["menu_items_ja", ["ja"]], ["menu_items_en", ["en", "ja"]]] as const) {
  const settings = await client.setSettings({
    indexName,
    indexSettings: {
      searchableAttributes: ["name", "restaurant_name", "description", "taste_tags", "category"],
      attributesForFaceting: [
        "filterOnly(allergens)", "filterOnly(dietary_tags)", "filterOnly(delivery_area_codes)", "filterOnly(restaurant_id)",
        "filterOnly(is_sold_out)", "filterOnly(allergen_data_complete)", "category", "cuisine", "taste_tags",
      ],
      numericAttributesForFiltering: ["price_incl_tax", "calories", "serving_from_min", "serving_to_min"],
      customRanking: ["desc(popularity)"],
      queryLanguages: [...langs],
      indexLanguages: [...langs],
      removeWordsIfNoResults: "allOptional",
    },
  });
  const syn = await client.saveSynonyms({ indexName, synonymHit: SYNONYMS.map((w, i) => ({ objectID: `syn_${i}`, type: "synonym" as const, synonyms: w })), replaceExistingSynonyms: true });
  const cleared = await client.clearObjects({ indexName });
  const saved = await client.saveObjects({ indexName, objects: records });
  pending.push(...[settings, syn, cleared, ...saved].map((t) => ({ indexName, taskID: t.taskID })));
  console.log(`✔ ${indexName}: ${records.length} records queued`);
}

if (process.argv.includes("--wait")) {
  for (const t of pending) await client.waitForTask({ ...t, maxRetries: 200 });
  console.log("[algolia] all tasks published");
} else {
  console.log("[algolia] tasks queued; they become searchable as Algolia publishes them (add --wait to block until done)");
}
await db.end();
