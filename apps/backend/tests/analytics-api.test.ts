import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * Phase 5 analytics API: workspace-scoped reads, window correctness,
 * zero-filling, source breakdowns, and isolation (401/403/404).
 * Aggregates are built by feeding GalleryViewed events through the real
 * consumer path (processAnalyticsRecord) with controlled timestamps.
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
    invitations: {
      createInvitation: vi.fn(async () => ({ id: "inv_aa", status: "pending" })),
    },
  })),
}));

vi.mock("../src/lib/storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/storage.js")>();
  const { default: sharp } = await import("sharp");
  const validPng = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 4, g: 14, b: 44 } },
  })
    .png()
    .toBuffer();
  return {
    ...actual,
    uploadPhoto: vi.fn(async (_e: unknown, b: Buffer) => ({
      storageFileId: `aw_aa_${Math.random().toString(36).slice(2, 10)}`,
      size: b.byteLength,
    })),
    deletePhotoQuietly: vi.fn(async () => undefined),
    checkBucket: vi.fn(async () => true),
    readPhotoBytes: vi.fn(async () => validPng),
  };
});

import { createApp } from "../src/server.js";
import { resetEnvCache } from "../src/config/env.js";
import { closePool, getPool } from "../src/lib/db.js";
import { makeGalleryViewed } from "../src/lib/analytics-events.js";
import { processAnalyticsRecord } from "../src/lib/analytics-sink.js";
import type { Env } from "../src/config/env.js";

function buildApp() {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://test:test@localhost:5432/test";
  process.env.CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY ?? "sk_test_placeholder";
  process.env.APPWRITE_ENDPOINT =
    process.env.APPWRITE_ENDPOINT ?? "https://cloud.appwrite.io/v1";
  process.env.APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID ?? "test-project";
  process.env.APPWRITE_API_KEY = process.env.APPWRITE_API_KEY ?? "test-key";
  process.env.APPWRITE_BUCKET_ID = process.env.APPWRITE_BUCKET_ID ?? "test-bucket";
  resetEnvCache();
  return createApp();
}

const dbUrl = process.env.TEST_DATABASE_URL;
const hasDb = !!dbUrl;
const describeIf = (cond: boolean) => (cond ? describe : describe.skip);

const adminA = { Authorization: "Bearer valid.clerk_aa_admin" };
const memberA = { Authorization: "Bearer valid.clerk_aa_member" };
const adminB = { Authorization: "Bearer valid.clerk_aa_admin_b" };

const VISITOR_A = "91111111-1111-4111-8111-111111111111";
const VISITOR_B = "92222222-2222-4222-8222-222222222222";
const DAY_1 = "2026-05-01";
const DAY_2 = "2026-05-02";
const DAY_3 = "2026-05-03";

function pngUpload(): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([header, Buffer.alloc(60)]);
}

describeIf(hasDb)("Analytics API", () => {
  let app: ReturnType<typeof createApp>;
  let env: Env;
  let eventId: string;
  let galleryId: string;
  let workspaceId: string;
  let otherGalleryId: string;

  beforeEach(async () => {
    process.env.DATABASE_URL = dbUrl!;
    process.env.DATABASE_SSL_CA = "";
    app = buildApp();
    const { loadEnv } = await import("../src/config/env.js");
    env = loadEnv();
    await seed(env);
    // Fresh galleries every test, but one shared workspace: wipe its analytics
    // so each test observes only the views it seeds.
    for (const table of [
      "gallery_traffic_visitors",
      "gallery_traffic_sources",
      "gallery_visitor_days",
      "gallery_daily_stats",
      "analytics_event_log",
    ]) {
      await getPool(env).query(
        `DELETE FROM ${table} WHERE workspace_id IN
         (SELECT id FROM workspaces WHERE name IN ('WS-aa-a','WS-aa-b'))`
      );
    }

    const created = await request(app)
      .post("/api/v1/events")
      .set(adminA)
      .send({ name: `AA Event ${Date.now()}`, event_date: "2026-12-01" });
    expect(created.status).toBe(201);
    eventId = created.body.event.id;
    const ws = await getPool(env).query<{ workspace_id: string }>(
      "SELECT workspace_id FROM events WHERE id = $1",
      [eventId]
    );
    workspaceId = ws.rows[0]!.workspace_id;

    const up = await request(app)
      .post(`/api/v1/events/${eventId}/photos`)
      .set(adminA)
      .attach("photos", pngUpload(), { filename: "aa.png", contentType: "image/png" });
    expect(up.status).toBe(201);
    const gal = await request(app)
      .post(`/api/v1/events/${eventId}/galleries`)
      .set(adminA)
      .send({ name: `AA Gallery ${Date.now()}`, photo_ids: [up.body.photos[0].id] });
    expect(gal.status).toBe(201);
    await request(app).post(`/api/v1/galleries/${gal.body.gallery.id}/publish`).set(adminA);
    galleryId = gal.body.gallery.id as string;

    // Other workspace gallery (isolation probe).
    const other = await request(app)
      .post("/api/v1/events")
      .set(adminB)
      .send({ name: `AA Other ${Date.now()}`, event_date: "2026-12-02" });
    expect(other.status).toBe(201);
    const upB = await request(app)
      .post(`/api/v1/events/${other.body.event.id}/photos`)
      .set(adminB)
      .attach("photos", pngUpload(), { filename: "aab.png", contentType: "image/png" });
    expect(upB.status).toBe(201);
    const galB = await request(app)
      .post(`/api/v1/events/${other.body.event.id}/galleries`)
      .set(adminB)
      .send({ name: `AA Gallery B ${Date.now()}`, photo_ids: [upB.body.photos[0].id] });
    expect(galB.status).toBe(201);
    await request(app).post(`/api/v1/galleries/${galB.body.gallery.id}/publish`).set(adminB);
    otherGalleryId = galB.body.gallery.id as string;
  });

  afterAll(async () => {
    const pool = getPool(env);
    for (const table of [
      "gallery_traffic_visitors",
      "gallery_traffic_sources",
      "gallery_visitor_days",
      "gallery_daily_stats",
      "analytics_event_log",
    ]) {
      await pool
        .query(
          `DELETE FROM ${table} WHERE workspace_id IN
           (SELECT id FROM workspaces WHERE name IN ('WS-aa-a','WS-aa-b'))`
        )
        .catch(() => undefined);
    }
    await pool.query(
      `DELETE FROM photos WHERE uploaded_by IN
       (SELECT id FROM users WHERE clerk_user_id LIKE 'clerk_aa_%')`
    );
    await pool.query("DELETE FROM events WHERE name LIKE 'AA Event %' OR name LIKE 'AA Other %'");
    await pool.query(
      `DELETE FROM event_team_members WHERE user_id IN
       (SELECT id FROM users WHERE clerk_user_id LIKE 'clerk_aa_%')`
    );
    await pool.query(
      `UPDATE workspaces SET created_by = NULL
       WHERE created_by IN (SELECT id FROM users WHERE clerk_user_id LIKE 'clerk_aa_%')`
    );
    await pool.query(
      `DELETE FROM users WHERE clerk_user_id IN
       ('clerk_aa_admin','clerk_aa_member','clerk_aa_admin_b')`
    );
    await pool.query(`DELETE FROM workspaces WHERE name IN ('WS-aa-a','WS-aa-b')`);
    await closePool();
  });

  async function addView(input: {
    gallery?: string;
    workspace?: string;
    at: string;
    visitor: string | null;
    source: string;
  }): Promise<void> {
    const event = {
      ...makeGalleryViewed({
        galleryId: input.gallery ?? galleryId,
        workspaceId: input.workspace ?? workspaceId,
        visitorId: input.visitor,
        correlationId: `corr-${Math.random().toString(36).slice(2)}`,
        trafficSource: { source: input.source, medium: null, campaign: null },
        photoCount: 1,
      }),
      occurredAt: `${input.at}T10:00:00.000Z`,
    };
    expect(await processAnalyticsRecord(env, event)).toBe("stored");
  }

  async function seedViews(): Promise<void> {
    await addView({ at: DAY_1, visitor: VISITOR_A, source: "direct" });
    await addView({ at: DAY_1, visitor: VISITOR_A, source: "google.com" });
    await addView({ at: DAY_2, visitor: VISITOR_A, source: "direct" });
    await addView({ at: DAY_2, visitor: VISITOR_B, source: "direct" });
    await addView({ at: DAY_2, visitor: null, source: "direct" });
  }

  it("gallery endpoint totals, windows, days, and sources", async () => {
    await seedViews();
    const res = await request(app)
      .get(`/api/v1/analytics/galleries/${galleryId}?from=${DAY_1}&to=${DAY_3}`)
      .set(adminA);
    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({ views: 5, unique_visitors: 2 });
    expect(res.body.by_day).toEqual([
      { day: DAY_1, views: 2, unique_visitors: 1 },
      { day: DAY_2, views: 3, unique_visitors: 2 },
      { day: DAY_3, views: 0, unique_visitors: 0 },
    ]);
    expect(res.body.sources).toEqual([
      { source: "direct", views: 4, unique_visitors: 2 },
      { source: "google.com", views: 1, unique_visitors: 1 },
    ]);

    const windowed = await request(app)
      .get(`/api/v1/analytics/galleries/${galleryId}?from=${DAY_2}&to=${DAY_2}`)
      .set(adminA);
    expect(windowed.body.totals).toEqual({ views: 3, unique_visitors: 2 });
    expect(windowed.body.by_day).toEqual([{ day: DAY_2, views: 3, unique_visitors: 2 }]);
  });

  it("overview scopes to the admin workspace", async () => {
    await seedViews();
    const otherWs = await getPool(env).query<{ workspace_id: string }>(
      "SELECT workspace_id FROM events WHERE name LIKE 'AA Other %' ORDER BY created_at DESC LIMIT 1"
    );
    expect(otherWs.rows[0]).toBeDefined();
    expect(
      await processAnalyticsRecord(env, {
        ...makeGalleryViewed({
          galleryId: otherGalleryId,
          workspaceId: otherWs.rows[0]!.workspace_id,
          visitorId: VISITOR_A,
          correlationId: "corr-other-1",
          trafficSource: { source: "direct", medium: null, campaign: null },
          photoCount: 1,
        }),
        occurredAt: `${DAY_2}T10:00:00.000Z`,
      })
    ).toBe("stored");

    const res = await request(app)
      .get(`/api/v1/analytics/overview?from=${DAY_1}&to=${DAY_3}`)
      .set(adminA);
    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({ views: 5, unique_visitors: 2, galleries: 1 });
    expect(res.body.galleries.map((g: { id: string }) => g.id)).toEqual([galleryId]);
    expect(res.body.sources.map((s: { source: string }) => s.source).sort()).toEqual([
      "direct",
      "google.com",
    ]);

    const resB = await request(app)
      .get(`/api/v1/analytics/overview?from=${DAY_1}&to=${DAY_3}`)
      .set(adminB);
    expect(resB.body.galleries.map((g: { id: string }) => g.id)).toEqual([otherGalleryId]);
  });

  it("enforces 401/403/404 without leaking", async () => {
    await seedViews();
    const anon = await request(app).get(`/api/v1/analytics/galleries/${galleryId}`);
    expect(anon.status).toBe(401);
    const member = await request(app)
      .get(`/api/v1/analytics/galleries/${galleryId}`)
      .set(memberA);
    expect(member.status).toBe(403);
    const memberOverview = await request(app).get("/api/v1/analytics/overview").set(memberA);
    expect(memberOverview.status).toBe(403);
    // Foreign workspace reads its own nothing and never sees A's gallery.
    const foreign = await request(app)
      .get(`/api/v1/analytics/galleries/${galleryId}`)
      .set(adminB);
    expect(foreign.status).toBe(404);
    const missing = await request(app)
      .get("/api/v1/analytics/galleries/00000000-0000-0000-0000-000000000000")
      .set(adminA);
    expect(missing.status).toBe(404);
  });

  it("rejects invalid ranges", async () => {
    for (const qs of ["?from=not-a-date", "?from=2026-13-01", "?from=2026-05-03&to=2026-05-01"]) {
      const res = await request(app).get(`/api/v1/analytics/galleries/${galleryId}${qs}`).set(adminA);
      expect(res.status).toBe(400);
    }
    const wide = await request(app)
      .get(`/api/v1/analytics/galleries/${galleryId}?from=2020-01-01&to=2022-01-02`)
      .set(adminA);
    expect(wide.status).toBe(400);
  });

  it("empty galleries report zeros with zero-filled days", async () => {
    const res = await request(app)
      .get(`/api/v1/analytics/galleries/${galleryId}?from=${DAY_1}&to=${DAY_2}`)
      .set(adminA);
    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({ views: 0, unique_visitors: 0 });
    expect(res.body.by_day).toEqual([
      { day: DAY_1, views: 0, unique_visitors: 0 },
      { day: DAY_2, views: 0, unique_visitors: 0 },
    ]);
    expect(res.body.sources).toEqual([]);
  });
});

async function seed(env: Env) {
  const pool = getPool(env);
  for (const name of ["WS-aa-a", "WS-aa-b"]) {
    await pool.query(
      `INSERT INTO workspaces (name) SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM workspaces WHERE name = $1)`,
      [name]
    );
  }
  await pool.query(
    `INSERT INTO users (clerk_user_id, name, email, role, workspace_id) VALUES
       ('clerk_aa_admin', 'AA Admin', 'aa_admin@frameflow.test', 'ADMIN',
         (SELECT id FROM workspaces WHERE name = 'WS-aa-a')),
       ('clerk_aa_member', 'AA Member', 'aa_member@frameflow.test', 'TEAM_MEMBER',
         (SELECT id FROM workspaces WHERE name = 'WS-aa-a')),
       ('clerk_aa_admin_b', 'AA Admin B', 'aa_admin_b@frameflow.test', 'ADMIN',
         (SELECT id FROM workspaces WHERE name = 'WS-aa-b'))
     ON CONFLICT (clerk_user_id) DO NOTHING`
  );
}

if (!hasDb) {
  console.warn("TEST_DATABASE_URL not set — skipping analytics API tests");
}
