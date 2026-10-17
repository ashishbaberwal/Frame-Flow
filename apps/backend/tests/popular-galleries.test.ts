import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * Phase 8 popular-galleries ranking: deterministic order (views, uniques,
 * downloads, id), exact window semantics (explicit, default, all-time),
 * the documented bot filter, draft exclusion + counting, deleted-gallery
 * dropout, workspace isolation, and auth/param enforcement.
 * Events are fed through the real consumer path (processAnalyticsRecord)
 * with controlled timestamps and client classes.
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
      createInvitation: vi.fn(async () => ({ id: "inv_pg", status: "pending" })),
    },
  })),
}));

vi.mock("../src/lib/storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/storage.js")>();
  const { default: sharp } = await import("sharp");
  const validPng = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 14, g: 4, b: 44 } },
  })
    .png()
    .toBuffer();
  return {
    ...actual,
    uploadPhoto: vi.fn(async (_e: unknown, b: Buffer) => ({
      storageFileId: `aw_pg_${Math.random().toString(36).slice(2, 10)}`,
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
import {
  makeGalleryShared,
  makeGalleryViewed,
  makePhotoDownloaded,
  makePhotoViewed,
} from "../src/lib/analytics-events.js";
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

const adminA = { Authorization: "Bearer valid.clerk_pg_admin" };
const memberA = { Authorization: "Bearer valid.clerk_pg_member" };
const adminB = { Authorization: "Bearer valid.clerk_pg_admin_b" };

const VISITOR_1 = "71111111-1111-4111-8111-111111111111";
const VISITOR_2 = "72222222-2222-4222-8222-222222222222";

const WINDOW_FROM = "2026-05-01";
const WINDOW_TO = "2026-05-31";
const DAY_IN = "2026-05-10";
const DAY_OUT = "2026-03-01";

type EventKind = "GalleryViewed" | "PhotoViewed" | "PhotoDownloaded" | "GalleryShared";

function pngUpload(): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([header, Buffer.alloc(60)]);
}

describeIf(hasDb)("Popular galleries ranking", () => {
  let app: ReturnType<typeof createApp>;
  let env: Env;
  let eventId: string;
  let photoId: string;
  let galleryId: string;
  let workspaceId: string;
  let galleryB: string;
  let workspaceB: string;

  beforeEach(async () => {
    process.env.DATABASE_URL = dbUrl!;
    process.env.DATABASE_SSL_CA = "";
    app = buildApp();
    const { loadEnv } = await import("../src/config/env.js");
    env = loadEnv();
    await seed(env);
    // Fresh galleries every test, but shared workspaces: wipe their analytics
    // so each test observes only the events it seeds.
    await wipeAnalytics(env);

    const created = await request(app)
      .post("/api/v1/events")
      .set(adminA)
      .send({ name: `PG Event ${Date.now()}`, event_date: "2026-12-01" });
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
      .attach("photos", pngUpload(), { filename: "pg.png", contentType: "image/png" });
    expect(up.status).toBe(201);
    photoId = up.body.photos[0].id as string;
    galleryId = await createGallery(`PG G1 ${Date.now()}`);
    await publish(galleryId);

    // Other workspace (isolation probe).
    const other = await request(app)
      .post("/api/v1/events")
      .set(adminB)
      .send({ name: `PG Other ${Date.now()}`, event_date: "2026-12-02" });
    expect(other.status).toBe(201);
    const wsB = await getPool(env).query<{ workspace_id: string }>(
      "SELECT workspace_id FROM events WHERE id = $1",
      [other.body.event.id]
    );
    workspaceB = wsB.rows[0]!.workspace_id;
    const upB = await request(app)
      .post(`/api/v1/events/${other.body.event.id}/photos`)
      .set(adminB)
      .attach("photos", pngUpload(), { filename: "pgb.png", contentType: "image/png" });
    expect(upB.status).toBe(201);
    const galB = await request(app)
      .post(`/api/v1/events/${other.body.event.id}/galleries`)
      .set(adminB)
      .send({ name: `PG GB ${Date.now()}`, photo_ids: [upB.body.photos[0].id] });
    expect(galB.status).toBe(201);
    galleryB = galB.body.gallery.id as string;
    await request(app).post(`/api/v1/galleries/${galleryB}/publish`).set(adminB);
  });

  afterAll(async () => {
    const pool = getPool(env);
    await wipeAnalytics(env).catch(() => undefined);
    await pool.query(
      `DELETE FROM photos WHERE uploaded_by IN
       (SELECT id FROM users WHERE clerk_user_id LIKE 'clerk_pg_%')`
    );
    await pool.query("DELETE FROM events WHERE name LIKE 'PG Event %' OR name LIKE 'PG Other %'");
    await pool.query(
      `DELETE FROM event_team_members WHERE user_id IN
       (SELECT id FROM users WHERE clerk_user_id LIKE 'clerk_pg_%')`
    );
    await pool.query(
      `UPDATE workspaces SET created_by = NULL
       WHERE created_by IN (SELECT id FROM users WHERE clerk_user_id LIKE 'clerk_pg_%')`
    );
    await pool.query(
      `DELETE FROM users WHERE clerk_user_id IN
       ('clerk_pg_admin','clerk_pg_member','clerk_pg_admin_b')`
    );
    await pool.query(`DELETE FROM workspaces WHERE name IN ('WS-pg-a','WS-pg-b')`);
    await closePool();
  });

  async function createGallery(name: string): Promise<string> {
    const gal = await request(app)
      .post(`/api/v1/events/${eventId}/galleries`)
      .set(adminA)
      .send({ name, photo_ids: [photoId] });
    expect(gal.status).toBe(201);
    return gal.body.gallery.id as string;
  }

  async function publish(id: string): Promise<void> {
    const res = await request(app).post(`/api/v1/galleries/${id}/publish`).set(adminA);
    expect(res.status).toBe(200);
  }

  async function addEvent(input: {
    kind: EventKind;
    gallery?: string;
    workspace?: string;
    at: string;
    visitor: string | null;
    clientClass?: "human" | "bot" | "suspicious";
  }): Promise<void> {
    const base = {
      galleryId: input.gallery ?? galleryId,
      workspaceId: input.workspace ?? workspaceId,
      visitorId: input.visitor,
      correlationId: `corr-${Math.random().toString(36).slice(2)}`,
      trafficSource: { source: "direct", medium: null, campaign: null },
      ...(input.clientClass ? { clientClass: input.clientClass } : {}),
    };
    const made =
      input.kind === "GalleryViewed"
        ? makeGalleryViewed({ ...base, photoCount: 1 })
        : input.kind === "PhotoViewed"
          ? makePhotoViewed({ ...base, photoId })
          : input.kind === "PhotoDownloaded"
            ? makePhotoDownloaded({ ...base, photoId })
            : makeGalleryShared({ ...base, channel: "native" });
    const stored = await processAnalyticsRecord(env, {
      ...made,
      occurredAt: `${input.at}T10:00:00.000Z`,
    });
    expect(stored).toBe("stored");
  }

  function query(params: string, token: Record<string, string> = adminA) {
    return request(app).get(`/api/v1/analytics/popular-galleries?${params}`).set(token);
  }

  it("ranks published galleries by views, then uniques, then downloads", async () => {
    const g2 = await createGallery(`PG G2 ${Date.now()}`);
    await publish(g2);
    const g3 = await createGallery(`PG G3 ${Date.now()}`);
    await publish(g3);
    const g4 = await createGallery(`PG G4 ${Date.now()}`);
    await publish(g4);

    // G1: 3 views, 2 uniques. Non-ranking event types must not move numbers.
    await addEvent({ kind: "GalleryViewed", at: DAY_IN, visitor: VISITOR_1 });
    await addEvent({ kind: "GalleryViewed", at: DAY_IN, visitor: VISITOR_1 });
    await addEvent({ kind: "GalleryViewed", at: DAY_IN, visitor: VISITOR_2 });
    await addEvent({ kind: "PhotoViewed", at: DAY_IN, visitor: VISITOR_1 });
    await addEvent({ kind: "GalleryShared", at: DAY_IN, visitor: VISITOR_1 });
    // G2: 5 views, 2 uniques, 1 download.
    for (const visitor of [VISITOR_1, VISITOR_1, VISITOR_1, VISITOR_2, VISITOR_2]) {
      await addEvent({ kind: "GalleryViewed", gallery: g2, at: DAY_IN, visitor });
    }
    await addEvent({ kind: "PhotoDownloaded", gallery: g2, at: DAY_IN, visitor: VISITOR_1 });
    // G3: 5 views, 4 uniques.
    for (const visitor of [VISITOR_1, VISITOR_2, "73333333-3333-4333-8333-333333333333", "74444444-4444-4444-8444-444444444444", VISITOR_1]) {
      await addEvent({ kind: "GalleryViewed", gallery: g3, at: DAY_IN, visitor });
    }
    // G4: downloads without an eligible view never rank.
    await addEvent({ kind: "PhotoDownloaded", gallery: g4, at: DAY_IN, visitor: VISITOR_1 });

    const res = await query(`from=${WINDOW_FROM}&to=${WINDOW_TO}`);
    expect(res.status).toBe(200);
    expect(res.body.range).toEqual({ from: WINDOW_FROM, to: WINDOW_TO });
    expect(res.body.excluded_drafts).toBe(0);
    expect(res.body.rankings.map((r: { gallery_id: string }) => r.gallery_id)).toEqual([
      g3,
      g2,
      galleryId,
    ]);
    expect(res.body.rankings.map((r: { rank: number }) => r.rank)).toEqual([1, 2, 3]);
    expect(res.body.rankings[0]).toMatchObject({ views: 5, unique_visitors: 4, downloads: 0 });
    expect(res.body.rankings[1]).toMatchObject({ views: 5, unique_visitors: 2, downloads: 1 });
    expect(res.body.rankings[2]).toMatchObject({ views: 3, unique_visitors: 2, downloads: 0 });
    expect(res.body.rankings[2].name).toBe(
      await galleryName(galleryId)
    );
  });

  it("breaks complete ties by gallery id, ascending", async () => {
    const g2 = await createGallery(`PG Tie A ${Date.now()}`);
    await publish(g2);
    const g3 = await createGallery(`PG Tie B ${Date.now()}`);
    await publish(g3);
    for (const g of [g2, g3]) {
      await addEvent({ kind: "GalleryViewed", gallery: g, at: DAY_IN, visitor: VISITOR_1 });
    }
    const res = await query(`from=${WINDOW_FROM}&to=${WINDOW_TO}`);
    const ids = res.body.rankings.map((r: { gallery_id: string }) => r.gallery_id);
    expect(ids).toEqual([g2, g3].sort());
  });

  it("counts exact window uniques; anonymous views never unique", async () => {
    // Same visitor on two days: 3 views, 1 unique (not a sum of daily uniques).
    await addEvent({ kind: "GalleryViewed", at: DAY_IN, visitor: VISITOR_1 });
    await addEvent({ kind: "GalleryViewed", at: DAY_IN, visitor: VISITOR_1 });
    await addEvent({ kind: "GalleryViewed", at: "2026-05-11", visitor: VISITOR_1 });
    await addEvent({ kind: "GalleryViewed", at: DAY_IN, visitor: null });
    const res = await query(`from=${WINDOW_FROM}&to=${WINDOW_TO}`);
    expect(res.body.rankings[0]).toMatchObject({ views: 4, unique_visitors: 1, downloads: 0 });
  });

  it("windows: explicit from/to, default trailing 30 days, and all-time", async () => {
    await addEvent({ kind: "GalleryViewed", at: DAY_IN, visitor: VISITOR_1 });
    await addEvent({ kind: "GalleryViewed", at: DAY_OUT, visitor: VISITOR_1 });
    const today = new Date().toISOString().slice(0, 10);
    await addEvent({ kind: "GalleryViewed", at: today, visitor: VISITOR_1 });

    const windowed = await query(`from=${WINDOW_FROM}&to=${WINDOW_TO}`);
    expect(windowed.body.rankings[0].views).toBe(1);

    const fallback = await query("");
    expect(fallback.body.range.to).toBe(today);
    expect(fallback.body.rankings[0].views).toBe(1); // only today's view is in range

    const all = await query("all=true");
    expect(all.body.range).toEqual({ all: true });
    expect(all.body.rankings[0].views).toBe(3);
  });

  it("bot-classified events never count and bot-only galleries never rank", async () => {
    await addEvent({ kind: "GalleryViewed", at: DAY_IN, visitor: VISITOR_1, clientClass: "human" });
    await addEvent({ kind: "GalleryViewed", at: DAY_IN, visitor: VISITOR_2, clientClass: "suspicious" });
    for (let i = 0; i < 5; i += 1) {
      await addEvent({ kind: "GalleryViewed", at: DAY_IN, visitor: VISITOR_1, clientClass: "bot" });
    }
    await addEvent({ kind: "PhotoDownloaded", at: DAY_IN, visitor: VISITOR_1, clientClass: "bot" });

    const g2 = await createGallery(`PG BotOnly ${Date.now()}`);
    await publish(g2);
    for (let i = 0; i < 50; i += 1) {
      await addEvent({ kind: "GalleryViewed", gallery: g2, at: DAY_IN, visitor: VISITOR_1, clientClass: "bot" });
    }

    const res = await query(`from=${WINDOW_FROM}&to=${WINDOW_TO}`);
    expect(res.body.rankings.map((r: { gallery_id: string }) => r.gallery_id)).toEqual([galleryId]);
    // human + suspicious count; only explicit bot is filtered.
    expect(res.body.rankings[0]).toMatchObject({ views: 2, unique_visitors: 2, downloads: 0 });
  });

  it("draft galleries are excluded from rankings and reported as a count", async () => {
    const draftWithViews = await createGallery(`PG Draft ${Date.now()}`); // never published
    const draftBotOnly = await createGallery(`PG DraftBot ${Date.now()}`);
    await addEvent({ kind: "GalleryViewed", at: DAY_IN, visitor: VISITOR_1 });
    await addEvent({ kind: "GalleryViewed", gallery: draftWithViews, at: DAY_IN, visitor: VISITOR_1 });
    await addEvent({
      kind: "GalleryViewed",
      gallery: draftBotOnly,
      at: DAY_IN,
      visitor: VISITOR_1,
      clientClass: "bot",
    });

    const res = await query(`from=${WINDOW_FROM}&to=${WINDOW_TO}`);
    expect(res.body.rankings.map((r: { gallery_id: string }) => r.gallery_id)).toEqual([galleryId]);
    // Only drafts with eligible activity "would have ranked".
    expect(res.body.excluded_drafts).toBe(1);
  });

  it("deleted galleries drop out; their events stay in the log", async () => {
    const g2 = await createGallery(`PG Doomed ${Date.now()}`);
    await publish(g2);
    await addEvent({ kind: "GalleryViewed", gallery: g2, at: DAY_IN, visitor: VISITOR_1 });
    await addEvent({ kind: "GalleryViewed", at: DAY_IN, visitor: VISITOR_1 });
    await getPool(env).query("DELETE FROM galleries WHERE id = $1", [g2]);

    const res = await query(`from=${WINDOW_FROM}&to=${WINDOW_TO}`);
    expect(res.body.rankings.map((r: { gallery_id: string }) => r.gallery_id)).toEqual([galleryId]);
    const log = await getPool(env).query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM analytics_event_log WHERE gallery_id = $1",
      [g2]
    );
    expect(log.rows[0]!.n).toBe(1);
  });

  it("limit caps the ranking list, not draft accounting", async () => {
    const g2 = await createGallery(`PG L2 ${Date.now()}`);
    await publish(g2);
    const g3 = await createGallery(`PG L3 ${Date.now()}`);
    await publish(g3);
    const draft = await createGallery(`PG LDraft ${Date.now()}`);
    await addEvent({ kind: "GalleryViewed", at: DAY_IN, visitor: VISITOR_1 });
    await addEvent({ kind: "GalleryViewed", gallery: g2, at: DAY_IN, visitor: VISITOR_1 });
    await addEvent({ kind: "GalleryViewed", gallery: g3, at: DAY_IN, visitor: VISITOR_1 });
    await addEvent({ kind: "GalleryViewed", gallery: draft, at: DAY_IN, visitor: VISITOR_1 });

    const res = await query(`from=${WINDOW_FROM}&to=${WINDOW_TO}&limit=2`);
    expect(res.body.rankings).toHaveLength(2);
    expect(res.body.rankings.map((r: { rank: number }) => r.rank)).toEqual([1, 2]);
    expect(res.body.excluded_drafts).toBe(1);
  });

  it("never leaks another workspace's galleries", async () => {
    await addEvent({ kind: "GalleryViewed", at: DAY_IN, visitor: VISITOR_1 });
    for (let i = 0; i < 10; i += 1) {
      await addEvent({
        kind: "GalleryViewed",
        gallery: galleryB,
        workspace: workspaceB,
        at: DAY_IN,
        visitor: VISITOR_1,
      });
    }
    const mine = await query(`from=${WINDOW_FROM}&to=${WINDOW_TO}`);
    expect(mine.body.rankings.map((r: { gallery_id: string }) => r.gallery_id)).toEqual([galleryId]);

    const theirs = await query(`from=${WINDOW_FROM}&to=${WINDOW_TO}`, adminB);
    expect(theirs.body.rankings.map((r: { gallery_id: string }) => r.gallery_id)).toEqual([galleryB]);
    expect(theirs.body.rankings[0].views).toBe(10);
  });

  it("requires admin auth and validates query parameters", async () => {
    const noToken = await request(app).get("/api/v1/analytics/popular-galleries");
    expect(noToken.status).toBe(401);
    const asMember = await query("", memberA);
    expect(asMember.status).toBe(403);

    expect((await query("from=2026-05-31&to=2026-05-01")).status).toBe(400);
    expect((await query("from=nope")).status).toBe(400);
    expect((await query("all=true&from=2026-05-01")).status).toBe(400);
    expect((await query("from=2025-01-01&to=2026-05-01")).status).toBe(400);
    expect((await query("limit=0")).status).toBe(400);
    expect((await query("limit=51")).status).toBe(400);
    expect((await query("limit=abc")).status).toBe(400);
  });

  async function galleryName(id: string): Promise<string> {
    const r = await getPool(env).query<{ name: string }>(
      "SELECT name FROM galleries WHERE id = $1",
      [id]
    );
    return r.rows[0]!.name;
  }
});

async function wipeAnalytics(env: Env): Promise<void> {
  for (const table of [
    "gallery_traffic_visitors",
    "gallery_traffic_sources",
    "gallery_visitor_days",
    "gallery_daily_stats",
    "photo_daily_stats",
    "analytics_event_log",
  ]) {
    await getPool(env).query(
      `DELETE FROM ${table} WHERE workspace_id IN
       (SELECT id FROM workspaces WHERE name IN ('WS-pg-a','WS-pg-b'))`
    );
  }
}

async function seed(env: Env) {
  const pool = getPool(env);
  for (const name of ["WS-pg-a", "WS-pg-b"]) {
    await pool.query(
      `INSERT INTO workspaces (name)
       SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM workspaces WHERE name = $1)`,
      [name]
    );
  }
  await pool.query(
    `INSERT INTO users (clerk_user_id, name, email, role, workspace_id) VALUES
       ('clerk_pg_admin', 'PG Admin', 'pg_admin@frameflow.test', 'ADMIN',
         (SELECT id FROM workspaces WHERE name = 'WS-pg-a')),
       ('clerk_pg_member', 'PG Member', 'pg_member@frameflow.test', 'TEAM_MEMBER',
         (SELECT id FROM workspaces WHERE name = 'WS-pg-a')),
       ('clerk_pg_admin_b', 'PG Admin B', 'pg_admin_b@frameflow.test', 'ADMIN',
         (SELECT id FROM workspaces WHERE name = 'WS-pg-b'))
     ON CONFLICT (clerk_user_id) DO NOTHING`
  );
}

if (!hasDb) {
  console.warn("TEST_DATABASE_URL not set — skipping popular-galleries tests");
}
