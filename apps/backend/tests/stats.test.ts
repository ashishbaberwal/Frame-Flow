import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * GET /api/v1/stats — the dashboard's real aggregates. Admins see the whole
 * workspace; team members see only their assigned events and get null
 * people-counts. Clerk/Appwrite are mocked; Postgres is real.
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
  };
});

import { createApp } from "../src/server.js";
import { resetEnvCache } from "../src/config/env.js";
import { closePool, getPool } from "../src/lib/db.js";
import type { Env } from "../src/config/env.js";

function buildApp() {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://test:test@localhost:5432/test";
  process.env.CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY ?? "sk_test_placeholder";
  process.env.APPWRITE_ENDPOINT = process.env.APPWRITE_ENDPOINT ?? "https://cloud.appwrite.io/v1";
  process.env.APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID ?? "test-project";
  process.env.APPWRITE_API_KEY = process.env.APPWRITE_API_KEY ?? "test-key";
  process.env.APPWRITE_BUCKET_ID = process.env.APPWRITE_BUCKET_ID ?? "test-bucket";
  resetEnvCache();
  return createApp();
}

const dbUrl = process.env.TEST_DATABASE_URL;
const hasDb = !!dbUrl;

const adminA = { Authorization: "Bearer valid.clerk_admin_1" };
const memberC = { Authorization: "Bearer valid.clerk_member_1" };
const adminB = { Authorization: "Bearer valid.clerk_admin_2" };

function png(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(50),
  ]);
}

describeIf(hasDb)("Dashboard stats", () => {
  let app: ReturnType<typeof createApp>;
  let env: Env;
  let eventA1: string;

  /** Vitest runs beforeEach before EVERY test — clear this suite's rows so
   * each test sees exactly one seed, not the accumulation of all of them. */
  async function cleanup() {
    const pool = getPool(env);
    await pool.query("DELETE FROM galleries WHERE event_id IN (SELECT id FROM events WHERE name LIKE 'Stats Ev %')");
    await pool.query("DELETE FROM photos WHERE event_id IN (SELECT id FROM events WHERE name LIKE 'Stats Ev %')");
    await pool.query("DELETE FROM events WHERE name LIKE 'Stats Ev %'");
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
  }

  beforeEach(async () => {
    process.env.DATABASE_URL = dbUrl!;
    process.env.DATABASE_SSL_CA = "";
    app = buildApp();
    const { loadEnv } = await import("../src/config/env.js");
    env = loadEnv();
    await cleanup();
    await seedWorkspaces(env);
    await seed(env);

    const a1 = await request(app)
      .post("/api/v1/events")
      .set(adminA)
      .send({ name: `Stats Ev A1 ${Date.now()}`, event_date: "2026-12-01" });
    eventA1 = a1.body.event.id;

    // Member C is assigned to A1; admin uploads one photo there, member one too.
    const memberId = await getPool(env).query<{ id: string }>(
      "SELECT id FROM users WHERE clerk_user_id = 'clerk_member_1'"
    );
    await request(app)
      .post(`/api/v1/events/${eventA1}/team-members`)
      .set(adminA)
      .send({ user_id: memberId.rows[0]!.id });

    for (const actor of [adminA, memberC]) {
      const p = await request(app)
        .post(`/api/v1/events/${eventA1}/photos`)
        .set(actor)
        .attach("photos", png(), { filename: "s.png", contentType: "image/png" });
      expect(p.status).toBe(201);
    }

    // Publish a gallery with one of the photos.
    const photos = await request(app).get(`/api/v1/events/${eventA1}/photos`).set(adminA);
    const gallery = await request(app)
      .post(`/api/v1/events/${eventA1}/galleries`)
      .set(adminA)
      .send({ name: `Stats Gallery ${Date.now()}`, photo_ids: [photos.body.photos[0].id] });
    const pub = await request(app)
      .post(`/api/v1/galleries/${gallery.body.gallery.id}/publish`)
      .set(adminA);
    expect(pub.status).toBe(200);
  }, 30_000);

  afterAll(async () => {
    await cleanup();
    await closePool();
  });

  it("admin sees real workspace totals", async () => {
    const res = await request(app).get("/api/v1/stats").set(adminA);
    expect(res.status).toBe(200);
    expect(res.body.stats.events).toBe(1);
    expect(res.body.stats.active_events).toBe(0);
    expect(res.body.stats.photos).toBe(2);
    expect(res.body.stats.published_galleries).toBe(1);
    expect(res.body.stats.team_members).toBe(2); // admin + invited member
    expect(res.body.stats.pending_invites).toBe(0);
  });

  it("uploads_per_day is zero-filled for 14 days and counts today's uploads", async () => {
    const res = await request(app).get("/api/v1/stats").set(adminA);
    expect(res.status).toBe(200);
    expect(res.body.uploads_per_day).toHaveLength(14);
    const today = res.body.uploads_per_day[res.body.uploads_per_day.length - 1];
    expect(today.uploads).toBe(2);
    expect(res.body.uploads_per_day.slice(0, -1).every((d: { uploads: number }) => d.uploads === 0)).toBe(true);
  });

  it("recent_activity is a real feed (photo upload and gallery publish)", async () => {
    const res = await request(app).get("/api/v1/stats").set(adminA);
    expect(res.status).toBe(200);
    const types = res.body.recent_activity.map((a: { type: string }) => a.type);
    expect(types).toContain("photo_uploaded");
    expect(types).toContain("gallery_published");
    expect(types).toContain("event_created");
    // Newest first — the gallery publish is the latest event in the seed.
    expect(res.body.recent_activity[0].type).toBe("gallery_published");
    expect(res.body.recent_activity[0].at).toBeTruthy();
  });

  it("member sees only assigned-event numbers and null people-counts", async () => {
    const res = await request(app).get("/api/v1/stats").set(memberC);
    expect(res.status).toBe(200);
    expect(res.body.stats.photos).toBe(2); // their one assigned event holds both photos
    expect(res.body.stats.published_galleries).toBe(1);
    expect(res.body.stats.team_members).toBeNull();
    expect(res.body.stats.pending_invites).toBeNull();
  });

  it("another workspace's admin cannot see A's numbers", async () => {
    const res = await request(app).get("/api/v1/stats").set(adminB);
    expect(res.status).toBe(200);
    expect(res.body.stats.events).toBe(0);
    expect(res.body.stats.photos).toBe(0);
  });
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
  console.warn("TEST_DATABASE_URL not set — skipping dashboard stats tests");
}
