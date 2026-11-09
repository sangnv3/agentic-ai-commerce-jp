/**
 * Applies db/migrations/*.sql in order, once each (tracked in schema_migrations), inside a transaction,
 * under an advisory lock so two instances never migrate at the same time.
 * Run: npm run db:migrate  (Railway runs it as the pre-deploy command).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
// Works from src/db (tsx) and dist/src/db (compiled): migrations live in <service>/db/migrations.
const dir = [path.resolve(here, "../../db/migrations"), path.resolve(here, "../../../db/migrations")].find((d) => {
  try {
    return readdirSync(d).length >= 0;
  } catch {
    return false;
  }
});
if (!dir) throw new Error("db/migrations not found");

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
});
await client.connect();
try {
  await client.query("SELECT pg_advisory_lock(727001)");
  await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const done = new Set((await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    await client.query("BEGIN");
    try {
      await client.query(readFileSync(path.join(dir, f), "utf8"));
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
      await client.query("COMMIT");
      console.log(`[migrate] applied ${f}`);
    } catch (e) {
      await client.query("ROLLBACK");
      throw new Error(`[migrate] ${f} failed: ${String(e)}`);
    }
  }
  console.log(`[migrate] up to date (${files.length} migrations)`);
} finally {
  await client.query("SELECT pg_advisory_unlock(727001)").catch(() => undefined);
  await client.end();
}
