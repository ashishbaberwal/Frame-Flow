import { createHash, randomUUID } from "node:crypto";
import { Redis } from "ioredis";

import type { Env } from "../config/env.js";

// ---------------------------------------------------------------------------
// Distributed rate limiting (Phase 7).
//
// Sliding-window limiter with two backends:
//
//   1. Redis (when REDIS_URL is set) — atomic Lua scripts, so every API
//      instance shares one budget. This is what makes limits real behind a
//      load balancer where each instance would otherwise get its own Map.
//   2. Per-process memory — the configured backend when REDIS_URL is unset
//      (local dev, tests), and the DEGRADED fallback when Redis is configured
//      but unreachable. Degradation is per class:
//        - sensitive classes (PIN brute force, uploads, admin API) fall back
//          to the in-memory window: protection is preserved per instance,
//          never silently dropped;
//        - non-sensitive classes (public reads, /me provisioning) fail OPEN:
//          availability for real customers outranks throttling during an
//          infrastructure outage, and the cost is bounded by the PIN gate.
//
// Failures are visible in structured logs (scope "rate-limit"), and a
// cooldown keeps a dead Redis from adding latency to every request. Keys are
// SHA-256 hashes of the bucket material — raw IPs / user ids never land in
// Redis, logs, or error messages.
//
// Policy table (documented in README → Rate limiting & abuse protection):
//   pin-failure   5       / 15 min   per slug+IP   (failure window, peek/record)
//   pin-attempt   30      / 15 min   per slug+IP   (all unlock attempts)
//   public-read   600     / 1 min    per IP
//   upload        30      / 10 min   per user
//   admin         300     / 10 min   per user
//   provision     120     / 5 min    per IP
// ---------------------------------------------------------------------------

export type RateLimitClass =
  | "pin-failure"
  | "pin-attempt"
  | "public-read"
  | "upload"
  | "admin"
  | "provision";

export type RateLimitPolicy = {
  /** Max events per window. */
  limit: number;
  windowMs: number;
  /**
   * Redis-down policy: true → fall back to the per-process window (never
   * weaker than the pre-Phase-7 limiter); false → allow (fail open).
   */
  sensitive: boolean;
};

/** Production defaults. Tests may override per limiter instance. */
export const RATE_LIMIT_POLICIES: Record<RateLimitClass, RateLimitPolicy> = {
  "pin-failure": { limit: 5, windowMs: 15 * 60 * 1000, sensitive: true },
  "pin-attempt": { limit: 30, windowMs: 15 * 60 * 1000, sensitive: true },
  "public-read": { limit: 600, windowMs: 60 * 1000, sensitive: false },
  upload: { limit: 30, windowMs: 10 * 60 * 1000, sensitive: true },
  admin: { limit: 300, windowMs: 10 * 60 * 1000, sensitive: true },
  provision: { limit: 120, windowMs: 5 * 60 * 1000, sensitive: false },
};

export const DEFAULT_RATE_LIMIT_KEY_PREFIX = "frameflow:rl:";

/** After a Redis failure, skip Redis attempts for this long. */
export const REDIS_COOLDOWN_MS = 15_000;
/** How long a request may wait for a lazily-connecting Redis at boot. */
export const REDIS_READY_WAIT_MS = 750;
/** Hard cap on in-memory bucket keys (unknown slugs can't grow it forever). */
const MAX_MEMORY_KEYS = 10_000;

export type RateLimitDecision = {
  allowed: boolean;
  /** 0 when allowed; ms until the window frees a slot when blocked. */
  retryAfterMs: number;
};

function log(event: string, detail: string): void {
  console.log(JSON.stringify({ scope: "rate-limit", event, detail }));
}

/** Opaque bucket key: SHA-256 of the class + material, never the raw value. */
function bucketHash(material: string): string {
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// Lua scripts — all decisions are single atomic round trips.
// ---------------------------------------------------------------------------

/**
 * Sliding-window consume: returns {1, 0} when admitted (and records the
 * event), {0, retryAfterMs} when the window is full (and records nothing —
 * blocked requests must not extend their own lockout).
 */
const CONSUME_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, '-inf', tostring(now - window))
local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry = window
  if oldest[2] then retry = tonumber(oldest[2]) + window - now end
  if retry < 0 then retry = 0 end
  return {0, retry}
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window)
return {1, 0}
`;

/** Peek at a window without recording: {count, retryAfterMsUntilOldest}. */
const PEEK_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', key, '-inf', tostring(now - window))
local count = redis.call('ZCARD', key)
local retry = 0
if count > 0 then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  if oldest[2] then retry = tonumber(oldest[2]) + window - now end
  if retry < 0 then retry = 0 end
end
return {count, retry}
`;

/** Record one event (failure) into a sliding window. */
const RECORD_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local member = ARGV[3]
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window)
return 1
`;

// ---------------------------------------------------------------------------
// Per-process memory backend (also the no-Redis configured backend).
// ---------------------------------------------------------------------------

const memoryBuckets = new Map<string, number[]>();

function pruneMemory(key: string, now: number, windowMs: number): number[] {
  const list = (memoryBuckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (list.length === 0) memoryBuckets.delete(key);
  else memoryBuckets.set(key, list);
  return list;
}

function evictIfNeeded(now: number, windowMs: number): void {
  if (memoryBuckets.size < MAX_MEMORY_KEYS) return;
  for (const key of [...memoryBuckets.keys()]) {
    pruneMemory(key, now, windowMs);
    if (memoryBuckets.size < MAX_MEMORY_KEYS) return;
  }
}

function memoryConsume(
  key: string,
  policy: RateLimitPolicy,
  now: number
): RateLimitDecision {
  const list = pruneMemory(key, now, policy.windowMs);
  if (list.length >= policy.limit) {
    const oldest = list[0] ?? now;
    return { allowed: false, retryAfterMs: Math.max(0, oldest + policy.windowMs - now) };
  }
  evictIfNeeded(now, policy.windowMs);
  list.push(now);
  memoryBuckets.set(key, list);
  return { allowed: true, retryAfterMs: 0 };
}

function memoryPeek(
  key: string,
  policy: RateLimitPolicy,
  now: number
): { count: number; retryAfterMs: number } {
  const list = pruneMemory(key, now, policy.windowMs);
  const oldest = list[0];
  return {
    count: list.length,
    retryAfterMs: oldest === undefined ? 0 : Math.max(0, oldest + policy.windowMs - now),
  };
}

function memoryRecord(key: string, policy: RateLimitPolicy, now: number): void {
  evictIfNeeded(now, policy.windowMs);
  const list = pruneMemory(key, now, policy.windowMs);
  list.push(now);
  memoryBuckets.set(key, list);
}

// ---------------------------------------------------------------------------
// Limiter
// ---------------------------------------------------------------------------

export type RateLimiterOptions = {
  /** Override some/all class policies (tests, special deployments). */
  policies?: Partial<Record<RateLimitClass, RateLimitPolicy>>;
  /** Redis key namespace; tests share one, prod uses the default. */
  keyPrefix?: string;
};

export class RateLimiter {
  private readonly redisUrl: string | null;
  private readonly keyPrefix: string;
  private readonly policies: Record<RateLimitClass, RateLimitPolicy>;
  private redis: Redis | null = null;
  private redisCooldownUntil = 0;
  private loggedCooldown = false;

  constructor(env: Env, options: RateLimiterOptions = {}) {
    this.redisUrl = env.REDIS_URL ?? null;
    this.keyPrefix = options.keyPrefix ?? DEFAULT_RATE_LIMIT_KEY_PREFIX;
    this.policies = { ...RATE_LIMIT_POLICIES, ...options.policies };
  }

  /** True when this limiter is backed by Redis (vs pure in-memory mode). */
  get redisConfigured(): boolean {
    return Boolean(this.redisUrl);
  }

  private policyFor(cls: RateLimitClass): RateLimitPolicy {
    return this.policies[cls];
  }

  private redisKey(cls: RateLimitClass, material: string): string {
    return `${this.keyPrefix}${cls}:${bucketHash(material)}`;
  }

  private memoryKey(cls: RateLimitClass, material: string): string {
    return `${cls}:${bucketHash(material)}`;
  }

  private connection(): Redis {
    if (!this.redis) {
      // Separate from BullMQ's connection: the request path must FAIL FAST
      // when Redis is down, not queue commands forever.
      this.redis = new Redis(this.redisUrl as string, {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        connectTimeout: 1500,
        enableReadyCheck: false,
      });
      this.redis.on("error", (err: Error) => {
        // Message only — the URL can carry credentials and is never logged.
        log("connection-error", err.message);
      });
    }
    return this.redis;
  }

  /**
   * Run one atomic script. Returns null when Redis cannot serve right now —
   * callers apply the class's degradation policy. Never throws.
   */
  private async evalScript(script: string, key: string, args: string[]): Promise<unknown | null> {
    if (!this.redisUrl) return null;
    const now = Date.now();
    if (now < this.redisCooldownUntil) return null;
    try {
      const redis = this.connection();
      if (redis.status !== "ready") {
        // Lazy connect at boot: give it a short grace period, then degrade.
        await Promise.race([
          redis.connect().catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, REDIS_READY_WAIT_MS)),
        ]);
      }
      if (redis.status !== "ready") throw new Error("Redis not ready");
      const result = await redis.eval(script, 1, key, ...args);
      this.loggedCooldown = false;
      return result;
    } catch (err) {
      this.redisCooldownUntil = now + REDIS_COOLDOWN_MS;
      if (!this.loggedCooldown) {
        this.loggedCooldown = true;
        log(
          "degraded",
          `Redis unavailable for ${REDIS_COOLDOWN_MS}ms; sensitive classes use the in-process window (message: ${
            (err as Error).message
          })`
        );
      }
      return null;
    }
  }

  /**
   * Check-and-record one request against its class budget. This is the
   * middleware primitive: one atomic step, shared across instances.
   */
  async consume(cls: RateLimitClass, material: string): Promise<RateLimitDecision> {
    const policy = this.policyFor(cls);
    const now = Date.now();
    if (this.redisUrl) {
      const raw = await this.evalScript(
        CONSUME_SCRIPT,
        this.redisKey(cls, material),
        [String(now), String(policy.windowMs), String(policy.limit), `${now}-${randomUUID()}`]
      );
      if (Array.isArray(raw)) {
        const allowed = Number(raw[0]) === 1;
        const retryAfterMs = Number(raw[1]);
        return { allowed, retryAfterMs: allowed ? 0 : retryAfterMs };
      }
      // Redis failed: class-specific degradation.
      if (policy.sensitive) return memoryConsume(this.memoryKey(cls, material), policy, now);
      return { allowed: true, retryAfterMs: 0 };
    }
    return memoryConsume(this.memoryKey(cls, material), policy, now);
  }

  /**
   * Failure-window primitives (PIN brute force). These are window logs that
   * record only failures and clear on success — semantics identical to the
   * pre-Phase-7 limiter, now shared across instances.
   */
  async failureWindow(
    cls: RateLimitClass,
    material: string
  ): Promise<{ limited: boolean; retryAfterMs: number }> {
    const policy = this.policyFor(cls);
    const now = Date.now();
    if (this.redisUrl) {
      const raw = await this.evalScript(PEEK_SCRIPT, this.redisKey(cls, material), [
        String(now),
        String(policy.windowMs),
      ]);
      if (Array.isArray(raw)) {
        const count = Number(raw[0]);
        return { limited: count >= policy.limit, retryAfterMs: count > 0 ? Number(raw[1]) : 0 };
      }
      if (policy.sensitive) {
        const peek = memoryPeek(this.memoryKey(cls, material), policy, now);
        return { limited: peek.count >= policy.limit, retryAfterMs: peek.retryAfterMs };
      }
      return { limited: false, retryAfterMs: 0 };
    }
    const peek = memoryPeek(this.memoryKey(cls, material), policy, now);
    return { limited: peek.count >= policy.limit, retryAfterMs: peek.retryAfterMs };
  }

  async recordFailure(cls: RateLimitClass, material: string): Promise<void> {
    const policy = this.policyFor(cls);
    const now = Date.now();
    if (this.redisUrl) {
      const raw = await this.evalScript(RECORD_SCRIPT, this.redisKey(cls, material), [
        String(now),
        String(policy.windowMs),
        `${now}-${randomUUID()}`,
      ]);
      if (raw === null && policy.sensitive) {
        memoryRecord(this.memoryKey(cls, material), policy, now);
      }
      return;
    }
    memoryRecord(this.memoryKey(cls, material), policy, now);
  }

  /** Successful verification wipes the failure window for this bucket. */
  async clearFailures(cls: RateLimitClass, material: string): Promise<void> {
    memoryBuckets.delete(this.memoryKey(cls, material));
    if (!this.redisUrl || Date.now() < this.redisCooldownUntil) return;
    try {
      const redis = this.connection();
      if (redis.status === "ready") {
        await redis.del(this.redisKey(cls, material));
      }
    } catch {
      // Best effort: the window expires on its own.
    }
  }

  /** Test/teardown helper: close the connection (does not clear state). */
  async close(): Promise<void> {
    const redis = this.redis;
    this.redis = null;
    if (!redis) return;
    try {
      if (redis.status === "ready") {
        await redis.quit().catch(() => undefined);
      } else if (typeof redis.disconnect === "function") {
        // Lazy/never-connected client: quit() would wait for a connection
        // that may never come. disconnect() is immediate and safe.
        redis.disconnect();
      } else {
        // Test doubles may only implement quit().
        await redis.quit().catch(() => undefined);
      }
    } catch {
      // Best-effort teardown must never surface as an unhandled rejection.
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton plumbing
// ---------------------------------------------------------------------------

let defaultLimiter: RateLimiter | null = null;
let defaultLimiterUrl: string | null = null;

/** Process-wide limiter for the configured env (rebuilt if REDIS_URL changes). */
export function getRateLimiter(env: Env): RateLimiter {
  const url = env.REDIS_URL ?? null;
  if (!defaultLimiter || defaultLimiterUrl !== url) {
    const previous = defaultLimiter;
    defaultLimiter = new RateLimiter(env);
    defaultLimiterUrl = url;
    void previous?.close();
  }
  return defaultLimiter;
}

/** Test helper: drop all limiter state (memory windows + connection). */
export function resetRateLimitState(): void {
  memoryBuckets.clear();
  const previous = defaultLimiter;
  defaultLimiter = null;
  defaultLimiterUrl = null;
  void previous?.close();
}
