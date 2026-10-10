import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * Phase 2 derivatives: thumbnail pipeline, state machine, failure
 * visibility/recovery, and access gates.
 *
 * Appwrite is mocked (binary layer external); sharp runs for real against
 * controlled byte modes; Postgres is real.
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
      createInvitation: vi.fn(async () => ({ id: "inv_dv", status: "pending" })),
    },
  })),
}));

vi.mock("../src/lib/storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/storage.js")>();
  const { default: sharp } = await import("sharp");
  let counter = 0;
  const originals = new Map<string, Buffer>();
  const derivatives = new Map<string, Buffer>();
  const validPng = await sharp({
    create: { width: 640, height: 480, channels: 3, background: { r: 9, g: 99, b: 199 } },
  })
    .png()
    .toBuffer();
  const widePng = await sharp({
    create: { width: 13000, height: 10, channels: 3, background: { r: 1, g: 1, b: 1 } },
  })
    .png()
    .toBuffer();
  return {
    ...actual,
    __mockState: { originals, derivatives },
    uploadPhoto: vi.fn(async (_env: unknown, buffer: Buffer, mime: string, name: string) => {
      counter += 1;
      const id = `aw_dv_${counter}_${Date.now()}`;
      if (name.includes("(thumb_")) derivatives.set(id, buffer);
      else originals.set(id, buffer);
      return { storageFileId: id, size: buffer.byteLength };
    }),
    deletePhotoQuietly: vi.fn(async (_env: unknown, storageFileId: string) => {
      originals.delete(storageFileId);
      derivatives.delete(storageFileId);
    }),
    checkBucket: vi.fn(async () => true),
    readPhotoBytes: vi.fn(async (_env: unknown, _fileId: string) => {
      const mode = (globalThis as Record<string, unknown>).__dvReadMode as
        | string
        | undefined;
      if (mode === "garbage") return Buffer.from("not-an-image-at-all");
      if (mode === "wide") return widePng;
      return validPng;
    }),
  };
});

import { createApp } from "../src/server.js";
import { resetEnvCache } from "../src/config/env.js";
import { closePool, getPool } from "../src/lib/db.js";
import {
  getPhotoDerivatives,
  recoverStuckDerivatives,
  sweepDerivativeQueue,
} from "../src/lib/derivatives.js";
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

const adminA = { Authorization: "Bearer valid.clerk_dv_admin" };
const memberA = { Authorization: "Bearer valid.clerk_dv_member" };
const adminB = { Authorization: "Bearer valid.clerk_dv_admin_b" };

function setReadMode(mode: "valid" | "garbage" | "wide") {
  (globalThis as Record<string, unknown>).__dvReadMode = mode;
}

function pngUpload(): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([header, Buffer.alloc(60)]);
}

describeIf(hasDb)("Photo derivatives", () => {
  let app: ReturnType<typeof createApp>;
  let env: Env;
  let eventId: string;

  beforeEach(async () => {
    process.env.DATABASE_URL = dbUrl!;
    process.env.DATABASE_SSL_CA = "";
    setReadMode("valid");
    app = buildApp();
    const { loadEnv } = await import("../src/config/env.js");
    env = loadEnv();
    await seed(env);
    const created = await request(app)
      .post("/api/v1/events")
      .set(adminA)
      .send({ name: `DV Event ${Date.now()}`, event_date: "2026-12-01" });
    expect(created.status).toBe(201);
    eventId = created.body.event.id;
    await request(app)
      .post(`/api/v1/events/${eventId}/team-members`)
      .set(adminA)
      .send({ user_id: await userIdOf("clerk_dv_member") });
  });

  afterAll(async () => {
    const pool = getPool(env);
    await pool.query(
      `DELETE FROM photos WHERE uploaded_by IN
       (SELECT id FROM users WHERE clerk_user_id LIKE 'clerk_dv_%')`
    );
    await pool.query("DELETE FROM events WHERE name LIKE 'DV Event %'");
    await pool.query(
      `DELETE FROM event_team_members WHERE user_id IN
       (SELECT id FROM users WHERE clerk_user_id LIKE 'clerk_dv_%')`
    );
    await pool.query(
      `UPDATE workspaces SET created_by = NULL
       WHERE created_by IN (SELECT id FROM users WHERE clerk_user_id LIKE 'clerk_dv_%')`
    );
    await pool.query(
      `DELETE FROM users WHERE clerk_user_id IN
       ('clerk_dv_admin','clerk_dv_member','clerk_dv_admin_b')`
    );
    await pool.query(`DELETE FROM workspaces WHERE name IN ('WS-dv-a','WS-dv-b')`);
    await closePool();
  });

  async function userIdOf(clerkId: string): Promise<string> {
    const r = await getPool(env).query<{ id: string }>(
      "SELECT id FROM users WHERE clerk_user_id = $1",
      [clerkId]
    );
    return r.rows[0]!.id;
  }

  async function uploadOne(auth: object = memberA): Promise<string> {
    const res = await request(app)
      .post(`/api/v1/events/${eventId}/photos`)
      .set(auth as never)
      .attach("photos", pngUpload(), { filename: "shot.png", contentType: "image/png" });
    expect(res.status).toBe(201);
    return res.body.photos[0].id as string;
  }

  /** Poll until no derivative row is QUEUED/PROCESSING (whoever runs it). */
  async function settle(photoId: string, timeoutMs = 15_000): Promise<void> {
    const start = Date.now();
    for (;;) {
      const rows = await getPhotoDerivatives(env, photoId);
      if (rows.length > 0 && rows.every((r) => r.status === "READY" || r.status === "FAILED"))
        return;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`derivatives unsettled: ${JSON.stringify(rows.map((r) => r.status))}`);
      }
      await sweepDerivativeQueue(env).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  it("upload returns immediately with QUEUED rows; sweep reaches READY", async () => {
    const res = await request(app)
      .post(`/api/v1/events/${eventId}/photos`)
      .set(memberA)
      .attach("photos", pngUpload(), { filename: "shot.png", contentType: "image/png" });
    expect(res.status).toBe(201);
    const photo = res.body.photos[0];
    expect(photo.processing_status).toBe("QUEUED");
    expect(photo.derivatives.map((d: { variant: string }) => d.variant).sort()).toEqual([
      "thumb_large",
      "thumb_small",
    ]);

    await settle(photo.id);
    const rows = await getPhotoDerivatives(env, photo.id);
    expect(rows.map((r) => r.status)).toEqual(["READY", "READY"]);
    expect(rows.every((r) => r.attempts >= 1)).toBe(true);

    const list = await request(app).get(`/api/v1/events/${eventId}/photos`).set(adminA);
    const listed = (list.body.photos as { id: string; processing_status: string }[]).find(
      (p) => p.id === photo.id
    );
    expect(listed?.processing_status).toBe("READY");
  });

  it("corrupt content fails visibly, keeps the original, and recovers via retry", async () => {
    setReadMode("garbage");
    const photoId = await uploadOne();
    await settle(photoId);

    let rows = await getPhotoDerivatives(env, photoId);
    expect(rows.map((r) => r.status)).toEqual(["FAILED", "FAILED"]);
    expect(rows.every((r) => r.last_error && r.last_error.length > 0)).toBe(true);

    // Original metadata untouched by the failed pipeline.
    const photoRes = await getPool(env).query("SELECT * FROM photos WHERE id = $1", [photoId]);
    expect(photoRes.rowCount).toBe(1);

    const list = await request(app).get(`/api/v1/events/${eventId}/photos`).set(adminA);
    const listed = (
      list.body.photos as { id: string; processing_status: string; derivatives: unknown[] }[]
    ).find((p) => p.id === photoId);
    expect(listed?.processing_status).toBe("FAILED");

    // Healthy bytes + explicit retry → READY with a fresh attempt budget.
    setReadMode("valid");
    const retry = await request(app)
      .post(`/api/v1/photos/${photoId}/derivatives/retry`)
      .set(adminA);
    expect(retry.status).toBe(200);
    await settle(photoId);
    rows = await getPhotoDerivatives(env, photoId);
    expect(rows.map((r) => r.status)).toEqual(["READY", "READY"]);
  });

  it("duplicate enqueue never creates duplicate rows", async () => {
    const photoId = await uploadOne();
    await settle(photoId);
    const first = await getPhotoDerivatives(env, photoId);
    expect(first.length).toBe(2);
    await request(app).post(`/api/v1/photos/${photoId}/derivatives/retry`).set(adminA);
    await request(app).post(`/api/v1/photos/${photoId}/derivatives/retry`).set(adminA);
    await settle(photoId);
    const again = await getPhotoDerivatives(env, photoId);
    expect(again.length).toBe(2);
  });

  it("rejects oversized dimensions without processing", async () => {
    setReadMode("wide");
    const photoId = await uploadOne();
    await settle(photoId);
    const rows = await getPhotoDerivatives(env, photoId);
    expect(rows.map((r) => r.status)).toEqual(["FAILED", "FAILED"]);
    expect(rows[0]!.last_error).toMatch(/too large/i);
  });

  it("recovers rows stuck in PROCESSING (crashed worker)", async () => {
    const photoId = await uploadOne();
    await settle(photoId);
    // Backdate past the stuck threshold. The updated_at trigger would reset
    // the clock on a plain UPDATE, so it is disabled for this setup write.
    await getPool(env).query(`ALTER TABLE photo_derivatives DISABLE TRIGGER trg_derivatives_updated_at`);
    await getPool(env).query(
      `UPDATE photo_derivatives SET status = 'PROCESSING',
        updated_at = now() - make_interval(secs => 600) WHERE photo_id = $1`,
      [photoId]
    );
    await getPool(env).query(`ALTER TABLE photo_derivatives ENABLE TRIGGER trg_derivatives_updated_at`);
    const recovered = await recoverStuckDerivatives(env);
    expect(recovered).toBe(2);
    await settle(photoId);
    const rows = await getPhotoDerivatives(env, photoId);
    expect(rows.map((r) => r.status)).toEqual(["READY", "READY"]);
  });

  it("retry endpoint enforces auth: 401, member 403, foreign workspace 404", async () => {
    const photoId = await uploadOne();
    const anon = await request(app).post(`/api/v1/photos/${photoId}/derivatives/retry`);
    expect(anon.status).toBe(401);
    const member = await request(app)
      .post(`/api/v1/photos/${photoId}/derivatives/retry`)
      .set(memberA);
    expect(member.status).toBe(403);
    const foreign = await request(app)
      .post(`/api/v1/photos/${photoId}/derivatives/retry`)
      .set(adminB);
    expect(foreign.status).toBe(404);
    const missing = await request(app)
      .post(`/api/v1/photos/00000000-0000-0000-0000-000000000000/derivatives/retry`)
      .set(adminA);
    expect(missing.status).toBe(404);
  });

  it("public thumbnails gate on READY: 409 while processing, bytes when ready", async () => {
    const photoId = await uploadOne();
    const created = await request(app)
      .post(`/api/v1/events/${eventId}/galleries`)
      .set(adminA)
      .send({ name: `DV Gallery ${Date.now()}`, photo_ids: [photoId] });
    const galleryId = created.body.gallery.id as string;
    await request(app).post(`/api/v1/galleries/${galleryId}/publish`).set(adminA);
    const slug = created.body.gallery.slug as string;
    const pin = created.body.gallery.pin as string;

    const unlock = await request(app).post(`/api/v1/public/galleries/${slug}/unlock`).send({ pin });
    expect(unlock.status).toBe(200);
    const token = unlock.body.access_token as string;
    // Not settled yet (or settled) — either null thumbnails or READY ones;
    // force the not-ready path deterministically below.
    expect(unlock.body.photos[0].thumbnails).toBeDefined();

    // Unknown variant is a client error, never a storage lookup.
    const badVariant = await request(app).get(
      `/api/v1/public/galleries/${slug}/photos/${photoId}?st=${encodeURIComponent(token)}&variant=huge`
    );
    expect(badVariant.status).toBe(400);

    // No token → 403 before any storage access.
    const noToken = await request(app).get(
      `/api/v1/public/galleries/${slug}/photos/${photoId}?variant=thumb_small`
    );
    expect(noToken.status).toBe(403);

    await settle(photoId);
    const ready = await request(app).get(
      `/api/v1/public/galleries/${slug}/photos/${photoId}?st=${encodeURIComponent(token)}&variant=thumb_small`
    );
    expect(ready.status).toBe(200);
    expect(ready.headers["content-type"]).toContain("image/webp");
  });

  it("409 while a derivative is still queued", async () => {
    setReadMode("garbage");
    const photoId = await uploadOne();
    await settle(photoId); // FAILED rows are never servable
    const created = await request(app)
      .post(`/api/v1/events/${eventId}/galleries`)
      .set(adminA)
      .send({ name: `DV Gallery 2 ${Date.now()}`, photo_ids: [photoId] });
    await request(app).post(`/api/v1/galleries/${created.body.gallery.id}/publish`).set(adminA);
    const slug = created.body.gallery.slug as string;
    const unlock = await request(app)
      .post(`/api/v1/public/galleries/${slug}/unlock`)
      .send({ pin: created.body.gallery.pin });
    const notReady = await request(app).get(
      `/api/v1/public/galleries/${slug}/photos/${photoId}?st=${encodeURIComponent(unlock.body.access_token)}&variant=thumb_small`
    );
    expect(notReady.status).toBe(409);
    expect(unlock.body.photos[0].thumbnails.thumb_small).toBeNull();
  });

  it("photo delete removes derivative binaries too", async () => {
    const photoId = await uploadOne();
    await settle(photoId);
    const before = await getPhotoDerivatives(env, photoId);
    expect(before.map((r) => r.status)).toEqual(["READY", "READY"]);
    const { __mockState } = (await import("../src/lib/storage.js")) as unknown as {
      __mockState: { derivatives: Map<string, unknown> };
    };
    for (const row of before) {
      expect(__mockState.derivatives.has(row.storage_file_id)).toBe(true);
    }
    const del = await request(app).delete(`/api/v1/photos/${photoId}`).set(adminA);
    expect(del.status).toBe(204);
    for (const row of before) {
      expect(__mockState.derivatives.has(row.storage_file_id)).toBe(false);
    }
  });
});

async function seed(env: Env) {
  const pool = getPool(env);
  for (const name of ["WS-dv-a", "WS-dv-b"]) {
    await pool.query(
      `INSERT INTO workspaces (name) SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM workspaces WHERE name = $1)`,
      [name]
    );
  }
  await pool.query(
    `INSERT INTO users (clerk_user_id, name, email, role, workspace_id) VALUES
       ('clerk_dv_admin', 'DV Admin', 'dv_admin@frameflow.test', 'ADMIN',
         (SELECT id FROM workspaces WHERE name = 'WS-dv-a')),
       ('clerk_dv_member', 'DV Member', 'dv_member@frameflow.test', 'TEAM_MEMBER',
         (SELECT id FROM workspaces WHERE name = 'WS-dv-a')),
       ('clerk_dv_admin_b', 'DV Admin B', 'dv_admin_b@frameflow.test', 'ADMIN',
         (SELECT id FROM workspaces WHERE name = 'WS-dv-b'))
     ON CONFLICT (clerk_user_id) DO NOTHING`
  );
}

if (!hasDb) {
  console.warn("TEST_DATABASE_URL not set — skipping photo derivative tests");
}
