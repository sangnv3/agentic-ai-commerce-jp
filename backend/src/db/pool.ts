import pg from "pg";
import { config } from "../config.js";

// DATE columns as 'YYYY-MM-DD' strings: the default Date conversion uses the server time zone and can shift
// a JST delivery date by one day on a UTC host.
pg.types.setTypeParser(1082, (v: string) => v);

export const db = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

export type Tx = pg.PoolClient;

/** Run fn in a transaction; rolls back on any error. */
export async function tx<T>(fn: (c: Tx) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
