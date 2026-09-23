/**
 * Fixed-window rate limiting with pluggable storage. The in-memory store is per-process;
 * the Redis store is shared across API replicas (any client exposing incr/pexpire/pttl works,
 * e.g. ioredis).
 */
export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetMs: number;
}

export interface RateLimiter {
  hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
}

export class MemoryRateLimiter implements RateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = Date.now();

  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    if (now - this.lastSweep > 60_000) {
      for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
      this.lastSweep = now;
    }
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, b);
    }
    b.count++;
    return { allowed: b.count <= limit, limit, remaining: Math.max(0, limit - b.count), resetMs: b.resetAt - now };
  }
}

export interface RedisLike {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  pttl(key: string): Promise<number>;
}

export class RedisRateLimiter implements RateLimiter {
  constructor(
    private redis: RedisLike,
    private prefix = 'roos:rl:',
  ) {}

  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const k = this.prefix + key;
    const count = await this.redis.incr(k);
    if (count === 1) await this.redis.pexpire(k, windowMs);
    let ttl = await this.redis.pttl(k);
    if (ttl < 0) {
      await this.redis.pexpire(k, windowMs);
      ttl = windowMs;
    }
    return { allowed: count <= limit, limit, remaining: Math.max(0, limit - count), resetMs: ttl };
  }
}
