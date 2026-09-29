export type RateLimitResult = {
  allowed: boolean;
  retryAfter: number;
  remaining: number;
};

export const rateLimitBucket = (nowMs: number, windowSeconds: number) =>
  Math.floor(nowMs / 1_000 / windowSeconds) * windowSeconds;

export const checkRateLimit = async (
  db: D1Database,
  namespace: string,
  key: string,
  limit: number,
  windowSeconds: number,
  nowMs = Date.now(),
): Promise<RateLimitResult> => {
  const bucketStart = rateLimitBucket(nowMs, windowSeconds);
  const rateKey = `${namespace}:${key}`;
  const row = await db
    .prepare(`
      INSERT INTO rate_limits (rate_key, bucket_start, count, expires_at)
      VALUES (?1, ?2, 1, ?3)
      ON CONFLICT(rate_key, bucket_start) DO UPDATE SET count = count + 1
      WHERE count < ?4
      RETURNING count
    `)
    .bind(rateKey, bucketStart, bucketStart + windowSeconds * 2, limit)
    .first<{ count: number }>();

  const elapsed = Math.floor(nowMs / 1_000) - bucketStart;
  return {
    allowed: Boolean(row),
    retryAfter: Math.max(1, windowSeconds - elapsed),
    remaining: row ? Math.max(0, limit - row.count) : 0,
  };
};
