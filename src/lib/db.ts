import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { config } from "./env";

// One pool per process (survives Next.js dev hot reloads via globalThis).
const g = globalThis as unknown as { __ragPool?: Pool };

export function pool(): Pool {
  if (!g.__ragPool) {
    g.__ragPool = new Pool({
      connectionString: config.databaseUrl,
      max: Number(process.env.PG_POOL_MAX ?? 10),
      ssl: process.env.PG_SSL === "true" ? { rejectUnauthorized: false } : undefined,
    });
  }
  return g.__ragPool;
}

export async function q<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool().query<T>(text, params);
  return res.rows;
}

export async function q1<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}

export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** pgvector text literal. */
export function toVector(v: number[] | Float32Array): string {
  return "[" + Array.from(v, (x) => (Number.isFinite(x) ? x.toFixed(7) : "0")).join(",") + "]";
}
