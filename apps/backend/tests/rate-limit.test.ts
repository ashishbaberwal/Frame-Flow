import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/config/env.js";
import {
  RateLimiter,
  RATE_LIMIT_POLICIES,
  resetRateLimitState,
} from "../src/lib/rate-limit.js";
import { createRateLimitMiddleware } from "../src/middleware/rate-limit.js";

/**
 * Rate limiter (Phase 7) — three layers of proof:
 *
 *   1. In-process window semantics (fake timers): exact allow/block counts,
 *      sliding expiry, blocked requests never extending their own lockout.
 *   2. Middleware contract: pass-through, 429 + Retry-After, null-key skip.
 *   3. Redis backend (REDIS_TEST_URL, real Redis): budgets and failure
 *      windows are SHARED across instances — the whole point of Phase 7 —
 *      plus degraded mode against an unreachable server (sensitive classes
 *      keep protecting via the per-process window; others fail open).
 */

function fakeEnv(redisUrl?: string): Env {
  return { REDIS_URL: redisUrl } as unknown as Env;
}

const redisTestUrl = process.env.REDIS_TEST_URL;
const describeRedis = redisTestUrl ? describe : describe.skip;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("RateLimiter — in-process backend (REDIS_URL unset)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    resetRateLimitState();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetRateLimitState();
  });

  it("allows exactly `limit` consumes, then blocks with the window's retry-after", async () => {
    const limiter = new RateLimiter(fakeEnv(), {
      policies: { admin: { limit: 3, windowMs: 10_000, sensitive: true } },
    });
    expect((await limiter.consume("admin", "u1")).allowed).toBe(true);
    expect((await limiter.consume("admin", "u1")).allowed).toBe(true);
    expect((await limiter.consume("admin", "u1")).allowed).toBe(true);

    const blocked = await limiter.consume("admin", "u1");
    expect(blocked.allowed).toBe(false);
    // All three events happened at t0 → a full window is the wait.
    expect(blocked.retryAfterMs).toBe(10_000);

    // Still blocked mid-window, with a shrinking retry-after.
    vi.advanceTimersByTime(4_000);
    const mid = await limiter.consume("admin", "u1");
    expect(mid.allowed).toBe(false);
    expect(mid.retryAfterMs).toBe(6_000);

    // The window slides: once the oldest events expire, the bucket reopens.
    vi.advanceTimersByTime(6_000);
    expect((await limiter.consume("admin", "u1")).allowed).toBe(true);
  });

  it("blocked requests do not extend their own lockout", async () => {
    const limiter = new RateLimiter(fakeEnv(), {
      policies: { admin: { limit: 1, windowMs: 10_000, sensitive: true } },
    });
    expect((await limiter.consume("admin", "u2")).allowed).toBe(true);

    // Hammer while blocked — none of these may be recorded.
    vi.advanceTimersByTime(9_000);
    for (let i = 0; i < 5; i++) {
      expect((await limiter.consume("admin", "u2")).allowed).toBe(false);
    }

    // One window after the SINGLE admitted request, the bucket is open again.
    vi.advanceTimersByTime(1_500);
    expect((await limiter.consume("admin", "u2")).allowed).toBe(true);
  });

  it("keeps independent buckets per class and material", async () => {
    const limiter = new RateLimiter(fakeEnv(), {
      policies: {
        admin: { limit: 1, windowMs: 10_000, sensitive: true },
        upload: { limit: 1, windowMs: 10_000, sensitive: true },
      },
    });
    expect((await limiter.consume("admin", "shared")).allowed).toBe(true);
    expect((await limiter.consume("admin", "shared")).allowed).toBe(false);
    // Different class, different material — both still fresh.
    expect((await limiter.consume("upload", "shared")).allowed).toBe(true);
    expect((await limiter.consume("admin", "other")).allowed).toBe(true);
  });

  it("failure windows record only failures, clear on success, and expire", async () => {
    const limiter = new RateLimiter(fakeEnv(), {
      policies: { "pin-failure": { limit: 5, windowMs: 900_000, sensitive: true } },
    });
    expect((await limiter.failureWindow("pin-failure", "s|ip")).limited).toBe(false);
    for (let i = 0; i < 4; i++) await limiter.recordFailure("pin-failure", "s|ip");
    expect((await limiter.failureWindow("pin-failure", "s|ip")).limited).toBe(false);

    await limiter.recordFailure("pin-failure", "s|ip");
    const limited = await limiter.failureWindow("pin-failure", "s|ip");
    expect(limited.limited).toBe(true);
    expect(limited.retryAfterMs).toBe(900_000);

    // A successful PIN clears the window entirely.
    await limiter.clearFailures("pin-failure", "s|ip");
    expect((await limiter.failureWindow("pin-failure", "s|ip")).limited).toBe(false);

    // And without a clear, the window slides out on its own.
    for (let i = 0; i < 5; i++) await limiter.recordFailure("pin-failure", "s|ip");
    expect((await limiter.failureWindow("pin-failure", "s|ip")).limited).toBe(true);
    vi.advanceTimersByTime(900_000);
    expect((await limiter.failureWindow("pin-failure", "s|ip")).limited).toBe(false);
  });

  it("ships production-sane default policies", () => {
    expect(RATE_LIMIT_POLICIES["pin-failure"]).toEqual({
      limit: 5,
      windowMs: 900_000,
      sensitive: true,
    });
    expect(RATE_LIMIT_POLICIES["pin-attempt"].limit).toBeGreaterThan(
      RATE_LIMIT_POLICIES["pin-failure"].limit
    );
    expect(RATE_LIMIT_POLICIES["public-read"].sensitive).toBe(false);
    expect(RATE_LIMIT_POLICIES.upload.limit).toBe(30);
  });
});

describe("createRateLimitMiddleware", () => {
  afterEach(() => {
    resetRateLimitState();
  });

  it("passes under the limit, answers 429 + Retry-After over it", async () => {
    const limiter = new RateLimiter(fakeEnv(), {
      policies: { admin: { limit: 2, windowMs: 60_000, sensitive: true } },
    });
    const app = express();
    app.get(
      "/limited",
      createRateLimitMiddleware({ limiter, cls: "admin", key: () => "fixed" }),
      (_req, res) => {
        res.json({ ok: true });
      }
    );

    expect((await request(app).get("/limited")).status).toBe(200);
    expect((await request(app).get("/limited")).status).toBe(200);

    const blocked = await request(app).get("/limited");
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe("Too many requests. Please try again shortly.");
    const retryAfter = Number(blocked.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it("skips limiting when the key callback yields null (no identity yet)", async () => {
    const limiter = new RateLimiter(fakeEnv(), {
      policies: { admin: { limit: 1, windowMs: 60_000, sensitive: true } },
    });
    const app = express();
    app.get(
      "/open",
      createRateLimitMiddleware({ limiter, cls: "admin", key: () => null }),
      (_req, res) => {
        res.json({ ok: true });
      }
    );
    for (let i = 0; i < 5; i++) {
      expect((await request(app).get("/open")).status).toBe(200);
    }
  });
});

describe("degraded mode — Redis configured but unreachable", () => {
  it("sensitive classes keep limiting via the in-process window; others fail open", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const limiter = new RateLimiter(fakeEnv("redis://127.0.0.1:1"), {
        policies: {
          upload: { limit: 2, windowMs: 60_000, sensitive: true },
          "public-read": { limit: 2, windowMs: 60_000, sensitive: false },
          "pin-failure": { limit: 5, windowMs: 60_000, sensitive: true },
        },
      });

      // Sensitive: the per-process window must still enforce the budget.
      const u1 = await limiter.consume("upload", "deg-u1");
      const u2 = await limiter.consume("upload", "deg-u1");
      const u3 = await limiter.consume("upload", "deg-u1");
      expect([u1.allowed, u2.allowed, u3.allowed]).toEqual([true, true, false]);
      expect(u3.retryAfterMs).toBeGreaterThan(0);

      // Non-sensitive: outage favors availability — requested, all allowed.
      for (const _ of [0, 1, 2, 3]) {
        expect((await limiter.consume("public-read", "deg-ip")).allowed).toBe(true);
      }

      // Failure-window primitives degrade the same way for sensitive classes.
      for (let i = 0; i < 5; i++) await limiter.recordFailure("pin-failure", "deg-slug|ip");
      expect((await limiter.failureWindow("pin-failure", "deg-slug|ip")).limited).toBe(true);
      await limiter.clearFailures("pin-failure", "deg-slug|ip");
      expect((await limiter.failureWindow("pin-failure", "deg-slug|ip")).limited).toBe(false);

      // The outage is logged once, and never with secrets.
      const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain('"event":"degraded"');

      await limiter.close();
    } finally {
      logSpy.mockRestore();
    }
  }, 15_000);
});

describeRedis("RateLimiter — Redis backend (REDIS_TEST_URL)", () => {
  const prefix = `frameflow:test:rl:${Date.now().toString(36)}:${Math.random()
    .toString(36)
    .slice(2, 8)}:`;
  let instanceA: RateLimiter;
  let instanceB: RateLimiter;

  beforeEach(() => {
    // Two limiters = two API instances sharing one Redis.
    instanceA = new RateLimiter(fakeEnv(redisTestUrl), { keyPrefix: prefix });
    instanceB = new RateLimiter(fakeEnv(redisTestUrl), { keyPrefix: prefix });
  });

  afterEach(async () => {
    await instanceA.close();
    await instanceB.close();
  });

  it("shares one consume budget across instances; blocked requests don't extend it", async () => {
    const policies = { admin: { limit: 2, windowMs: 700, sensitive: true } } as const;
    const a = new RateLimiter(fakeEnv(redisTestUrl), { keyPrefix: prefix, policies });
    const b = new RateLimiter(fakeEnv(redisTestUrl), { keyPrefix: prefix, policies });
    try {
      // Unique material so reruns of the suite never collide.
      const material = `shared-${Math.random().toString(36).slice(2, 10)}`;
      expect((await a.consume("admin", material)).allowed).toBe(true);
      expect((await a.consume("admin", material)).allowed).toBe(true);

      // Instance B sees A's consumption — the whole point of Redis-backed limits.
      const blocked = await b.consume("admin", material);
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfterMs).toBeGreaterThan(0);
      expect(blocked.retryAfterMs).toBeLessThanOrEqual(700);

      // Blocked requests were not recorded: one window after the ADMITTED
      // requests, the bucket reopens.
      await sleep(blocked.retryAfterMs + 250);
      expect((await b.consume("admin", material)).allowed).toBe(true);
    } finally {
      await a.close();
      await b.close();
    }
  }, 15_000);

  it("shares PIN failure windows across instances, and success clears them everywhere", async () => {
    const policies = { "pin-failure": { limit: 5, windowMs: 5_000, sensitive: true } } as const;
    const a = new RateLimiter(fakeEnv(redisTestUrl), { keyPrefix: prefix, policies });
    const b = new RateLimiter(fakeEnv(redisTestUrl), { keyPrefix: prefix, policies });
    try {
      const material = `pin-${Math.random().toString(36).slice(2, 10)}`;
      for (let i = 0; i < 4; i++) await a.recordFailure("pin-failure", material);
      expect((await b.failureWindow("pin-failure", material)).limited).toBe(false);

      await a.recordFailure("pin-failure", material);
      const limitedOnB = await b.failureWindow("pin-failure", material);
      expect(limitedOnB.limited).toBe(true);
      expect(limitedOnB.retryAfterMs).toBeGreaterThan(0);

      // A success on instance B must clear the shared window for A too.
      await b.clearFailures("pin-failure", material);
      expect((await a.failureWindow("pin-failure", material)).limited).toBe(false);
    } finally {
      await a.close();
      await b.close();
    }
  }, 15_000);
});

if (!redisTestUrl) {
  console.warn("REDIS_TEST_URL not set — skipping Redis-backed rate limiter tests");
}
