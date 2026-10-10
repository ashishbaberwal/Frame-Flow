import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * Phase 4 route emission: unlock emits GalleryViewed, proxied photo serving
 * emits PhotoViewed/PhotoDownloaded, visitor context echoes through, and
 * analytics outages never break gallery serving. The producer is mocked
 * (its own resilience is unit-tested); Postgres is real.
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
      createInvitation: vi.fn(async () => ({ id: "inv_an", status: "pending" })),
    },
  })),
}));

vi.mock("../src/lib/storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/storage.js")>();
  const { default: sharp } = await import("sharp");
  const validPng = await sharp({
    create: { width: 320, height: 240, channels: 3, background: { r: 44, g: 4, b: 14 } },
  })
    .png()
    .toBuffer();
  return {
    ...actual,
    uploadPhoto: vi.fn(async (_e: unknown, b: Buffer) => ({
      storageFileId: `aw_an_${Math.random().toString(36).slice(2, 10)}`,
      size: b.byteLength,
    })),
    deletePhotoQuietly: vi.fn(async () => undefined),
    checkBucket: vi.fn(async () => true),
    readPhotoBytes: vi.fn(async () => validPng),
  };
});

vi.mock("../src/lib/analytics-producer.js", () => ({
  publishAnalyticsEvent: async (_env: unknown, event: Record<string, unknown>) => {
    const g = globalThis as Record<string, unknown>;
    if (!Array.isArray(g.__analyticsEvents)) g.__analyticsEvents = [];
    (g.__analyticsEvents as unknown[]).push(event);
    if (g.__analyticsFail) return { published: false, reason: "publish-failed" };
    return { published: true };
  },
}));

import { createApp } from "../src/server.js";
import { resetEnvCache } from "../src/config/env.js";
import { closePool, getPool } from "../src/lib/db.js";
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

const adminA = { Authorization: "Bearer valid.clerk_an_admin" };
const memberA = { Authorization: "Bearer valid.clerk_an_member" };
const VISITOR = "66666666-6666-4666-8666-666666666666";

type Captured = Record<string, unknown>;

function captured(): Captured[] {
  return ((globalThis as Record<string, unknown>).__analyticsEvents as Captured[]) ?? [];
}

function clearCaptured() {
  (globalThis as Record<string, unknown>).__analyticsEvents = [];
}

async function flush() {
  await new Promise((r) => setTimeout(r, 100));
}

function pngUpload(): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([header, Buffer.alloc(60)]);
}

describeIf(hasDb)("Analytics route emission", () => {
  let app: ReturnType<typeof createApp>;
  let env: Env;
  let eventId: string;
  let slug: string;
  let pin: string;
  let photoId: string;

  beforeEach(async () => {
    process.env.DATABASE_URL = dbUrl!;
    process.env.DATABASE_SSL_CA = "";
    clearCaptured();
    (globalThis as Record<string, unknown>).__analyticsFail = false;
    app = buildApp();
    const { loadEnv } = await import("../src/config/env.js");
    env = loadEnv();
    await seed(env);

    const created = await request(app)
      .post("/api/v1/events")
      .set(adminA)
      .send({ name: `AN Event ${Date.now()}`, event_date: "2026-12-01" });
    eventId = created.body.event.id;
    await request(app)
      .post(`/api/v1/events/${eventId}/team-members`)
      .set(adminA)
      .send({ user_id: await userIdOf("clerk_an_member") });

    const up = await request(app)
      .post(`/api/v1/events/${eventId}/photos`)
      .set(memberA)
      .attach("photos", pngUpload(), { filename: "an.png", contentType: "image/png" });
    photoId = up.body.photos[0].id as string;

    const gal = await request(app)
      .post(`/api/v1/events/${eventId}/galleries`)
      .set(adminA)
      .send({ name: `AN Gallery ${Date.now()}`, photo_ids: [photoId] });
    await request(app).post(`/api/v1/galleries/${gal.body.gallery.id}/publish`).set(adminA);
    slug = gal.body.gallery.slug as string;
    pin = gal.body.gallery.pin as string;
    clearCaptured();
  });

  afterAll(async () => {
    const pool = getPool(env);
    await pool.query(
      `DELETE FROM photos WHERE uploaded_by IN
       (SELECT id FROM users WHERE clerk_user_id LIKE 'clerk_an_%')`
    );
    await pool.query("DELETE FROM events WHERE name LIKE 'AN Event %'");
    await pool.query(
      `DELETE FROM event_team_members WHERE user_id IN
       (SELECT id FROM users WHERE clerk_user_id LIKE 'clerk_an_%')`
    );
    await pool.query(
      `UPDATE workspaces SET created_by = NULL
       WHERE created_by IN (SELECT id FROM users WHERE clerk_user_id LIKE 'clerk_an_%')`
    );
    await pool.query(
      `DELETE FROM users WHERE clerk_user_id IN ('clerk_an_admin','clerk_an_member')`
    );
    await pool.query(`DELETE FROM workspaces WHERE name = 'WS-an-a'`);
    await closePool();
  });

  async function userIdOf(clerkId: string): Promise<string> {
    const r = await getPool(env).query<{ id: string }>(
      "SELECT id FROM users WHERE clerk_user_id = $1",
      [clerkId]
    );
    return r.rows[0]!.id;
  }

  it("unlock emits GalleryViewed with workspace scope and echoed visitor", async () => {
    const res = await request(app)
      .post(`/api/v1/public/galleries/${slug}/unlock`)
      .set("x-visitor-id", VISITOR)
      .send({ pin });
    expect(res.status).toBe(200);
    expect(res.body.visitor_id).toBe(VISITOR.toLowerCase());
    expect(typeof res.body.correlation_id).toBe("string");

    await flush();
    expect(captured().length).toBe(1);
    const event = captured()[0]!;
    expect(event.eventType).toBe("GalleryViewed");
    expect(event.visitorId).toBe(VISITOR.toLowerCase());
    expect(event.correlationId).toBe(res.body.correlation_id);
    expect(event.photoCount).toBe(1);

    const ws = await getPool(env).query<{ workspace_id: string }>(
      "SELECT workspace_id FROM events WHERE id = $1",
      [eventId]
    );
    expect(event.workspaceId).toBe(ws.rows[0]!.workspace_id);

    // No secrets, ever.
    const json = JSON.stringify(event);
    expect(json).not.toContain(pin);
    expect(json).not.toContain("st=");
    expect(json).not.toMatch(/sk_/);
  });

  it("mints a visitor id when the client sends none or garbage", async () => {
    const noHeader = await request(app)
      .post(`/api/v1/public/galleries/${slug}/unlock`)
      .send({ pin });
    expect(noHeader.body.visitor_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    const garbage = await request(app)
      .post(`/api/v1/public/galleries/${slug}/unlock`)
      .set("x-visitor-id", "not-a-uuid")
      .send({ pin });
    expect(garbage.body.visitor_id).not.toBe("not-a-uuid");
  });

  it("photo serving emits stitched view/download events", async () => {
    const unlock = await request(app)
      .post(`/api/v1/public/galleries/${slug}/unlock`)
      .set("x-visitor-id", VISITOR)
      .send({ pin });
    const token = unlock.body.access_token as string;
    const correlation = unlock.body.correlation_id as string;
    clearCaptured();

    const view = await request(app).get(
      `/api/v1/public/galleries/${slug}/photos/${photoId}?st=${encodeURIComponent(token)}&v=${VISITOR}&c=${correlation}`
    );
    expect(view.status).toBe(200);
    const dl = await request(app).get(
      `/api/v1/public/galleries/${slug}/photos/${photoId}?st=${encodeURIComponent(token)}&v=${VISITOR}&c=${correlation}&dl=1`
    );
    expect(dl.status).toBe(200);

    await flush();
    const types = captured().map((e) => e.eventType).sort();
    expect(types).toEqual(["PhotoDownloaded", "PhotoViewed"]);
    for (const e of captured()) {
      expect(e.visitorId).toBe(VISITOR.toLowerCase());
      expect(e.correlationId).toBe(correlation);
      expect(e.photoId).toBe(photoId);
    }
  });

  it("analytics outage keeps galleries serving", async () => {
    (globalThis as Record<string, unknown>).__analyticsFail = true;
    const unlock = await request(app)
      .post(`/api/v1/public/galleries/${slug}/unlock`)
      .set("x-visitor-id", VISITOR)
      .send({ pin });
    expect(unlock.status).toBe(200);
    expect(unlock.body.photos.length).toBe(1);
    const view = await request(app).get(
      `/api/v1/public/galleries/${unlock.body.gallery.slug}/photos/${photoId}?st=${encodeURIComponent(unlock.body.access_token)}`
    );
    expect(view.status).toBe(200);
  });

  it("follow-up pages carry tracking in photo URLs", async () => {
    const unlock = await request(app)
      .post(`/api/v1/public/galleries/${slug}/unlock`)
      .set("x-visitor-id", VISITOR)
      .send({ pin });
    const url = unlock.body.photos[0].url as string;
    expect(url).toContain(`v=${VISITOR.toLowerCase()}`);
    expect(url).toContain("c=");

    const list = await request(app).get(
      `/api/v1/public/galleries/${slug}/photos?st=${encodeURIComponent(unlock.body.access_token)}&c=${unlock.body.correlation_id}`
    );
    expect(list.status).toBe(200);
    expect((list.body.photos[0].url as string)).toContain(`c=${unlock.body.correlation_id}`);
  });
});

async function seed(env: Env) {
  const pool = getPool(env);
  await pool.query(
    `INSERT INTO workspaces (name) SELECT 'WS-an-a' WHERE NOT EXISTS (SELECT 1 FROM workspaces WHERE name = 'WS-an-a')`
  );
  await pool.query(
    `INSERT INTO users (clerk_user_id, name, email, role, workspace_id) VALUES
       ('clerk_an_admin', 'AN Admin', 'an_admin@frameflow.test', 'ADMIN',
         (SELECT id FROM workspaces WHERE name = 'WS-an-a')),
       ('clerk_an_member', 'AN Member', 'an_member@frameflow.test', 'TEAM_MEMBER',
         (SELECT id FROM workspaces WHERE name = 'WS-an-a'))
     ON CONFLICT (clerk_user_id) DO NOTHING`
  );
}

if (!hasDb) {
  console.warn("TEST_DATABASE_URL not set — skipping analytics route tests");
}
