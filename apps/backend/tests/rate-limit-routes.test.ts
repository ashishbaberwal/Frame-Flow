import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * Rate limiting on the HTTP surface (Phase 7). The limiter's own semantics
 * are unit/integration-tested in rate-limit.test.ts (including the Redis
 * backend); this suite proves the ROUTE wiring end to end against real
 * Postgres:
 *
 *   - the pin-attempt budget blocks a hammering client with 429 + Retry-After
 *   - the 5-failure PIN window refuses even the correct PIN while locked
 *   - budgets are scoped per slug: one attacked gallery never locks another
 *
 * The limiter runs on its default in-process backend here (no REDIS_URL),
 * matching local dev; resetRateLimitState() keeps buckets fresh per test.
 */

vi.mock("@clerk/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clerk/backend")>();
  return {
    ...actual,
    verifyToken: vi.fn(async (token: string) => {
      if (token.startsWith("valid.")) {
        return { sub: token.slice("valid.".length) } as { sub: string };
      }
      throw new Error("invalid token");
    }),
  };
});

vi.mock("../src/lib/clerk.js", () => ({
  getClerkClientForEnv: vi.fn(() => ({
    invitations: { createInvitation: vi.fn(async () => ({ id: "inv_x" })) },
  })),
}));

vi.mock("../src/lib/storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/storage.js")>();
  return {
    ...actual,
    uploadPhoto: vi.fn(async (_e: unknown, b: Buffer) => ({
      storageFileId: `aw_${b.length}_${Math.random().toString(36).slice(2, 8)}`,
      size: b.byteLength,
    })),
    deletePhotoQuietly: vi.fn(async () => undefined),
    checkBucket: vi.fn(async () => true),
    readPhotoBytes: vi.fn(async (_e: unknown, fileId: string) =>
      Buffer.concat([Buffer.from(`bytes-of-${fileId}:`), Buffer.alloc(24, 7)])
    ),
  };
});

import { createApp } from "../src/server.js";
import { resetEnvCache } from "../src/config/env.js";
import { closePool, getPool } from "../src/lib/db.js";
import { resetRateLimitState } from "../src/lib/rate-limit.js";
import type { Env } from "../src/config/env.js";

function buildApp() {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://test:test@localhost:5432/test";
  process.env.CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY ?? "sk_test_placeholder";
  process.env.APPWRITE_ENDPOINT = process.env.APPWRITE_ENDPOINT ?? "https://cloud.appwrite.io/v1";
  process.env.APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID ?? "test-project";
  process.env.APPWRITE_API_KEY = process.env.APPWRITE_API_KEY ?? "test-key";
  process.env.APPWRITE_BUCKET_ID = process.env.APPWRITE_BUCKET_ID ?? "test-bucket";
  // Deliberately no REDIS_URL: default in-process backend.
  delete process.env.REDIS_URL;
  resetEnvCache();
  return createApp();
}

const dbUrl = process.env.TEST_DATABASE_URL;
const hasDb = !!dbUrl;

const adminA = { Authorization: "Bearer valid.clerk_admin_1" };

function png(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(50),
  ]);
}

describeIf(hasDb)("Rate-limited routes", () => {
  let app: ReturnType<typeof createApp>;
  let env: Env;
  let publishedSlug: string;
  let publishedPin: string;

  beforeEach(async () => {
    resetRateLimitState();
    process.env.DATABASE_URL = dbUrl!;
    process.env.DATABASE_SSL_CA = "";
    app = buildApp();
    const { loadEnv } = await import("../src/config/env.js");
    env = loadEnv();
    await seedWorkspaces(env);
    await seed(env);

    const event = await request(app)
      .post("/api/v1/events")
      .set(adminA)
      .send({ name: `RL Routes Ev ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, event_date: "2026-12-06" });
    expect(event.status).toBe(201);

    const photo = await request(app)
      .post(`/api/v1/events/${event.body.event.id}/photos`)
      .set(adminA)
      .attach("photos", png(), { filename: "rl.png", contentType: "image/png" });
    expect(photo.status).toBe(201);

    const created = await request(app)
      .post(`/api/v1/events/${event.body.event.id}/galleries`)
      .set(adminA)
      .send({ name: `RL Gallery ${Date.now()}`, photo_ids: [photo.body.photos[0].id] });
    expect(created.status).toBe(201);
    const pub = await request(app)
      .post(`/api/v1/galleries/${created.body.gallery.id}/publish`)
      .set(adminA);
    expect(pub.status).toBe(200);
    publishedSlug = created.body.gallery.slug;
    publishedPin = created.body.gallery.pin;
  }, 30_000);

  afterAll(async () => {
    resetRateLimitState();
    const pool = getPool(env);
    await pool.query(
      "DELETE FROM galleries WHERE event_id IN (SELECT id FROM events WHERE name LIKE 'RL Routes Ev %')"
    );
    await pool.query(
      "DELETE FROM photos WHERE event_id IN (SELECT id FROM events WHERE name LIKE 'RL Routes Ev %')"
    );
    await pool.query("DELETE FROM events WHERE name LIKE 'RL Routes Ev %'");
    await pool.query(
      `DELETE FROM photos WHERE uploaded_by IN
       (SELECT id FROM users WHERE clerk_user_id IN ('clerk_admin_1','clerk_member_1','clerk_admin_2'))`
    );
    await pool.query(
      `DELETE FROM invitations WHERE invited_by IN (SELECT id FROM users WHERE clerk_user_id LIKE 'clerk_%')`
    );
    await pool.query(
      `DELETE FROM event_team_members WHERE user_id IN (SELECT id FROM users WHERE clerk_user_id LIKE 'clerk_%')`
    );
    await pool.query(
      `UPDATE workspaces SET created_by = NULL WHERE created_by IN (SELECT id FROM users WHERE clerk_user_id LIKE 'clerk_%')`
    );
    await pool.query(
      `DELETE FROM users WHERE clerk_user_id IN ('clerk_admin_1','clerk_member_1','clerk_admin_2')`
    );
    await pool.query(
      `DELETE FROM workspaces WHERE name IN ('WS-admin@frameflow.test','WS-admin2@frameflow.test')`
    );
    await closePool();
  });

  it("exhausted pin-attempt budget answers 429 + Retry-After, scoped to the attacked slug", async () => {
    // Unknown slug: attempts consume the budget but never touch the failure
    // window (404 before the PIN is compared) — isolating the attempt cap.
    const ghostSlug = `ghost-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    for (let i = 0; i < 30; i++) {
      const res = await request(app)
        .post(`/api/v1/public/galleries/${ghostSlug}/unlock`)
        .send({ pin: "000000" });
      expect(res.status, `attempt ${i + 1}`).toBe(404);
    }

    const blocked = await request(app)
      .post(`/api/v1/public/galleries/${ghostSlug}/unlock`)
      .send({ pin: "000000" });
    expect(blocked.status).toBe(429);
    expect(blocked.body.photos).toBeUndefined();
    const retryAfter = Number(blocked.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(15 * 60);

    // A different gallery's bucket is untouched by the flood: a wrong PIN
    // there is still an ordinary 403, not a lockout.
    const other = await request(app)
      .post(`/api/v1/public/galleries/${publishedSlug}/unlock`)
      .send({ pin: publishedPin === "000000" ? "000001" : "000000" });
    expect(other.status).toBe(403);
  }, 60_000);

  it("five wrong PINs lock the gallery for everyone on that slug — correct PIN gets 429 + Retry-After", async () => {
    const wrongPin = publishedPin === "000000" ? "000001" : "000000";
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post(`/api/v1/public/galleries/${publishedSlug}/unlock`)
        .send({ pin: wrongPin });
      expect(res.status, `wrong attempt ${i + 1}`).toBe(403);
    }

    const locked = await request(app)
      .post(`/api/v1/public/galleries/${publishedSlug}/unlock`)
      .send({ pin: publishedPin });
    expect(locked.status).toBe(429);
    expect(locked.body.error).toMatch(/too many/i);
    const retryAfter = Number(locked.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(15 * 60);
  }, 60_000);
});

async function seedWorkspaces(env: Env) {
  const pool = getPool(env);
  for (const name of ["WS-admin@frameflow.test", "WS-admin2@frameflow.test"]) {
    await pool.query(
      `INSERT INTO workspaces (name) SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM workspaces WHERE name = $1)`,
      [name]
    );
  }
}

async function seed(env: Env) {
  const pool = getPool(env);
  await pool.query(
    `INSERT INTO users (clerk_user_id, name, email, role, workspace_id) VALUES
       ('clerk_admin_1', 'Admin A', 'admin@frameflow.test', 'ADMIN',
         (SELECT id FROM workspaces WHERE name = 'WS-admin@frameflow.test')),
       ('clerk_member_1', 'Member C', 'member@frameflow.test', 'TEAM_MEMBER',
         (SELECT id FROM workspaces WHERE name = 'WS-admin@frameflow.test')),
       ('clerk_admin_2', 'Admin B', 'admin2@frameflow.test', 'ADMIN',
         (SELECT id FROM workspaces WHERE name = 'WS-admin2@frameflow.test'))
     ON CONFLICT (clerk_user_id) DO NOTHING`
  );
}

function describeIf(cond: boolean) {
  return cond ? describe : describe.skip;
}

if (!hasDb) {
  console.warn("TEST_DATABASE_URL not set — skipping rate-limited route tests");
}
