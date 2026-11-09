/**
 * CLI: load the sample restaurants and menu.
 *   npm run dev:seed                         # local
 *   npm run dev:seed -- --stock itm_1021=0   # e.g. make an item sold out to test re-planning
 */
import { seedSampleData } from "./sampleSeed.js";
import { db } from "./pool.js";

if (process.env.SEED_SAMPLE_DATA !== "true" && process.env.NODE_ENV === "production") {
  console.log("[seed] skipped (set SEED_SAMPLE_DATA=true to load the sample restaurants and menu)");
  process.exit(0);
}
const stockArgs = new Map<string, number>();
const i = process.argv.indexOf("--stock");
if (i > 0) for (const kv of (process.argv[i + 1] ?? "").split(",")) { const [k, v] = kv.split("="); if (k && v !== undefined) stockArgs.set(k, Number(v)); }
await seedSampleData(stockArgs);
await db.end();
