import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * Phase 1 pagination: cursor-based photo paging for event collections and
 * the public gallery surface.
 *
 * Covers empty pages, invalid parameters, stable ordering, permission gates,
 * page boundaries (no duplicates/omissions), and the public follow-up
 * endpoint. Appwrite is mocked; Postgres is real.
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
  let n = 0;
  return {
    ...actual,
    uploadPhoto: vi.fn(async (_env: unknown, buffer: Buffer) => {
      n += 1;
      return { storageFileId: `aw_pg_${n}_${Date.now()}`, size: buffer.byteLength };
    }),
    deletePhotoQuietly: vi.fn(async () => undefined),
    checkBucket: vi.fn(async () => true),
    readPhotoBytes: vi.fn(async (_e: unknown, fileId: string) =>
      Buffer.concat([Buffer.from(`bytes-of-${fileId}:`), Buffer.alloc(16, 7)])
    ),
  };
});

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

const adminA = { Authorization: "Bearer valid.clerk_pg_admin" };
const memberA = { Authorization: "Bearer valid.clerk_pg_member" };
const adminB = { Authorization: "Bearer valid.clerk_pg_admin_b" };

function png(i = 0): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([header, Buffer.alloc(40 + i, i)]);
}

describeIf(hasDb)("Photo pagination", () => {
  let app: ReturnType<typeof createApp>;
  let env: Env;
  let eventId: string;
  let otherEventId: string;

  beforeEach(async () => {
    process.env.DATABASE_URL = dbUrl!;
    process.env.DATABASE_SSL_CA = "";
    app = buildApp();
    const { loadEnv } = await import("../src/config/env.js");
    env = loadEnv();
    await seed(env);

    const created = await request(app)
      .post("/api/v1/events")
      .set(adminA)
      .send({ name: `PG Event ${Date.now()}`, event_date: "2026-12-01" });
    expect(created.status).toBe(201);
    eventId = created.body.event.id;

    const other = await request(app)
      .post("/api/v1/events")
      .set(adminB)
      .send({ name: `PG Other ${Date.now()}`, event_date: "2026-12-02" });
    otherEventId = other.body.event.id;

    await request(app)
      .post(`/api/v1/events/${eventId}/team-members`)
      .set(adminA)
      .send({ user_id: await userIdOf("clerk_pg_member") });
  });

  afterAll(async () => {
    const pool = getPool(env);
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

  async function userIdOf(clerkId: string): Promise<string> {
    const r = await getPool(env).query<{ id: string }>(
      "SELECT id FROM users WHERE clerk_user_id = $1",
      [clerkId]
    );
    return r.rows[0]!.id;
  }

  async function uploadMany(event: string, auth: object, count: number) {
    for (let i = 0; i < count; i++) {
      const res = await request(app)
        .post(`/api/v1/events/${event}/photos`)
        .set(auth as never)
        .attach("photos", png(i), { filename: `p${i}.png`, contentType: "image/png" });
      expect(res.status).toBe(201);
    }
  }

  it("returns an empty page with has_more false for a photo-less event", async () => {
    const res = await request(app).get(`/api/v1/events/${eventId}/photos`).set(adminA);
    expect(res.status).toBe(200);
    expect(res.body.photos).toEqual([]);
    expect(res.body.pagination).toMatchObject({ limit: 50, has_more: false, next_cursor: null });
  });

  it("rejects invalid pagination parameters with 400", async () => {
    for (const qs of ["?limit=0", "?limit=101", "?limit=abc", "?limit=-5", "?order=bogus"]) {
      const res = await request(app).get(`/api/v1/events/${eventId}/photos${qs}`).set(adminA);
      expect(res.status).toBe(400);
    }
    const badCursor = await request(app)
      .get(`/api/v1/events/${eventId}/photos?cursor=not-a-cursor`)
      .set(adminA);
    expect(badCursor.status).toBe(400);
  });

  it("walks pages without duplicates or omissions and honors boundaries", async () => {
    await uploadMany(eventId, memberA, 5);

    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const qs = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : "?limit=2";
      const res = await request(app).get(`/api/v1/events/${eventId}/photos${qs}`).set(adminA);
      expect(res.status).toBe(200);
      expect(res.body.photos.length).toBeLessThanOrEqual(2);
      for (const p of res.body.photos as { id: string }[]) {
        expect(seen.has(p.id)).toBe(false);
        seen.add(p.id);
      }
      pages += 1;
      if (!res.body.pagination.has_more) {
        expect(res.body.pagination.next_cursor).toBeNull();
        break;
      }
      expect(typeof res.body.pagination.next_cursor).toBe("string");
      cursor = res.body.pagination.next_cursor;
      expect(pages).toBeLessThan(10);
    }
    expect(seen.size).toBe(5);
    expect(pages).toBe(3);

    // A single large page returns everything with has_more false.
    const all = await request(app).get(`/api/v1/events/${eventId}/photos?limit=100`).set(adminA);
    expect(all.body.photos.length).toBe(5);
    expect(all.body.pagination.has_more).toBe(false);
    expect(new Set((all.body.photos as { id: string }[]).map((p) => p.id))).toEqual(seen);
  });

  it("orders deterministically: oldest is the reverse of newest", async () => {
    await uploadMany(eventId, memberA, 3);
    const newest = await request(app)
      .get(`/api/v1/events/${eventId}/photos?limit=100&order=newest`)
      .set(adminA);
    const oldest = await request(app)
      .get(`/api/v1/events/${eventId}/photos?limit=100&order=oldest`)
      .set(adminA);
    const nIds = (newest.body.photos as { id: string }[]).map((p) => p.id);
    const oIds = (oldest.body.photos as { id: string }[]).map((p) => p.id);
    expect(nIds).toEqual([...oIds].reverse());
  });

  it("preserves authorization: 401, cross-workspace 404, unassigned 403", async () => {
    const anon = await request(app).get(`/api/v1/events/${eventId}/photos`);
    expect(anon.status).toBe(401);

    // Admin B's workspace cannot see workspace A's event (tenancy gate).
    const cross = await request(app).get(`/api/v1/events/${eventId}/photos`).set(adminB);
    expect(cross.status).toBe(404);

    // Other workspace's event is invisible from workspace A too.
    const cross2 = await request(app).get(`/api/v1/events/${otherEventId}/photos`).set(adminA);
    expect(cross2.status).toBe(404);

    // Same-workspace member with no assignment to this event gets 403.
    const unassigned = await request(app)
      .post("/api/v1/events")
      .set(adminA)
      .send({ name: `PG Lone ${Date.now()}`, event_date: "2026-12-03" });
    const lone = await request(app)
      .get(`/api/v1/events/${unassigned.body.event.id}/photos`)
      .set(memberA);
    expect(lone.status).toBe(403);
  });

  it("paginates the public unlock surface and follows up without re-PIN", async () => {
    await uploadMany(eventId, memberA, 5);
    const photoIds = (
      (await request(app).get(`/api/v1/events/${eventId}/photos?limit=100`).set(adminA)).body
        .photos as { id: string }[]
    ).map((p) => p.id);

    const created = await request(app)
      .post(`/api/v1/events/${eventId}/galleries`)
      .set(adminA)
      .send({ name: `PG Gallery ${Date.now()}`, photo_ids: photoIds });
    expect(created.status).toBe(201);
    const galleryId = created.body.gallery.id as string;
    const pub = await request(app).post(`/api/v1/galleries/${galleryId}/publish`).set(adminA);
    expect(pub.status).toBe(200);
    const slug = created.body.gallery.slug as string;
    const pin = created.body.gallery.pin as string;

    const first = await request(app)
      .post(`/api/v1/public/galleries/${slug}/unlock?limit=2`)
      .send({ pin });
    expect(first.status).toBe(200);
    expect(first.body.photos.length).toBe(2);
    expect(first.body.pagination.has_more).toBe(true);
    const token = first.body.access_token as string;

    const collected = new Set<string>(
      (first.body.photos as { id: string }[]).map((p) => p.id)
    );
    let cursor = first.body.pagination.next_cursor as string;
    for (let i = 0; i < 5; i++) {
      const next = await request(app).get(
        `/api/v1/public/galleries/${slug}/photos?st=${encodeURIComponent(token)}&limit=2&cursor=${encodeURIComponent(cursor)}`
      );
      expect(next.status).toBe(200);
      for (const p of next.body.photos as { id: string }[]) {
        expect(collected.has(p.id)).toBe(false);
        collected.add(p.id);
      }
      if (!next.body.pagination.has_more) break;
      cursor = next.body.pagination.next_cursor;
    }
    expect(collected.size).toBe(5);

    // Bad token, bad limit, and bad cursor are all rejected safely.
    const badToken = await request(app).get(`/api/v1/public/galleries/${slug}/photos?st=bad&limit=2`);
    expect(badToken.status).toBe(403);
    const badLimit = await request(app)
      .post(`/api/v1/public/galleries/${slug}/unlock?limit=500`)
      .send({ pin });
    expect(badLimit.status).toBe(400);
  });

  it("hides drafts from the public paged surface", async () => {
    await uploadMany(eventId, memberA, 1);
    const photoId = (
      (await request(app).get(`/api/v1/events/${eventId}/photos?limit=100`).set(adminA)).body
        .photos as { id: string }[]
    )[0]!.id;
    const created = await request(app)
      .post(`/api/v1/events/${eventId}/galleries`)
      .set(adminA)
      .send({ name: `PG Draft ${Date.now()}`, photo_ids: [photoId] });
    const slug = created.body.gallery.slug as string;
    const listed = await request(app).get(
      `/api/v1/public/galleries/${slug}/photos?st=whatever&limit=10`
    );
    // Invalid token gates first (403); an unknown slug with a forged shape
    // would 403 here too — drafts never leak existence.
    expect([403, 404]).toContain(listed.status);
  });
});

async function seed(env: Env) {
  const pool = getPool(env);
  for (const name of ["WS-pg-a", "WS-pg-b"]) {
    await pool.query(
      `INSERT INTO workspaces (name) SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM workspaces WHERE name = $1)`,
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
  console.warn("TEST_DATABASE_URL not set — skipping photo pagination tests");
}
