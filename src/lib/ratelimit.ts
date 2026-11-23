// Fixed-window rate limiting backed by Postgres, so limits hold across every app instance.

import { q, q1 } from "./db";

export interface RateResult {
  ok: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
}

export async function hit(bucket: string, key: string, limit: number, windowSeconds: number): Promise<RateResult> {
  if (limit <= 0) return { ok: false, limit, remaining: 0, resetSeconds: windowSeconds };
  const nowMs = Date.now();
  const windowStartMs = Math.floor(nowMs / (windowSeconds * 1000)) * windowSeconds * 1000;
  const row = await q1<{ count: number }>(
    `INSERT INTO rate_limits (bucket, key, window_start, count) VALUES ($1, $2, to_timestamp($3 / 1000.0), 1)
     ON CONFLICT (bucket, key, window_start) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count`,
    [bucket, key, windowStartMs],
  );
  const count = row?.count ?? 1;
  if (Math.random() < 0.01) {
    void q("DELETE FROM rate_limits WHERE window_start < now() - interval '2 days'").catch(() => {});
  }
  return {
    ok: count <= limit,
    limit,
    remaining: Math.max(0, limit - count),
    resetSeconds: Math.ceil((windowStartMs + windowSeconds * 1000 - nowMs) / 1000),
  };
}

/** Undo a hit (used when a request is rejected later for a reason that should not cost the visitor). */
export async function refund(bucket: string, key: string, windowSeconds: number): Promise<void> {
  const windowStartMs = Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000;
  await q(
    "UPDATE rate_limits SET count = greatest(count - 1, 0) WHERE bucket = $1 AND key = $2 AND window_start = to_timestamp($3 / 1000.0)",
    [bucket, key, windowStartMs],
  );
}
