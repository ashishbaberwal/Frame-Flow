import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * Public gallery surface (customer link): metadata, PIN unlock, and the
 * rate limit that guards it. These endpoints are intentionally UNAUTHENTICATED
 * — no Clerk header is ever sent — so the suite proves the gate in server.ts
 * admits /public/* while everything else stays behind requireAuth.
 * Appwrite binary layer is mocked; Postgres is real.
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

function png(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(50),
  ]);
}

describeIf(hasDb)("Public gallery surface", () => {
  let app: ReturnType<typeof createApp>;
  let env: Env;
  let eventId: string;
  let photoId: string;

  /** Published gallery: created, published, slug + PIN captured. */
  let publishedSlug: string;
  let publishedPin: string;
  /** Draft gallery: exists but must behave like a missing one publicly. */
  let draftSlug: string;

  async function makeGallery(name: string, publish: boolean) {
    const created = await request(app)
      .post(`/api/v1/events/${eventId}/galleries`)
      .set(adminA)
      .send({ name, photo_ids: [photoId] });
    expect(created.status).toBe(201);
    if (publish) {
      const pub = await request(app)
        .post(`/api/v1/galleries/${created.body.gallery.id}/publish`)
        .set(adminA);
      expect(pub.status).toBe(200);
    }
    return { slug: created.body.gallery.slug as string, pin: created.body.gallery.pin as string };
  }

  beforeEach(async () => {
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
      .send({ name: `Public Gal Ev ${Date.now()}`, event_date: "2026-12-05" });
    eventId = event.body.event.id;

    const photo = await request(app)
      .post(`/api/v1/events/${eventId}/photos`)
      .set(adminA)
      .attach("photos", png(), { filename: "pub.png", contentType: "image/png" });
    expect(photo.status).toBe(201);
    photoId = photo.body.photos[0].id;

    const published = await makeGallery(`Customer Gallery ${Date.now()}`, true);
    publishedSlug = published.slug;
    publishedPin = published.pin;
    draftSlug = (await makeGallery(`Unpublished Draft ${Date.now()}`, false)).slug;
  }, 30_000);

  afterAll(async () => {
    const pool = getPool(env);
    await pool.query("DELETE FROM galleries WHERE event_id IN (SELECT id FROM events WHERE name LIKE 'Public Gal Ev %')");
    await pool.query("DELETE FROM photos WHERE event_id IN (SELECT id FROM events WHERE name LIKE 'Public Gal Ev %')");
    await pool.query("DELETE FROM events WHERE name LIKE 'Public Gal Ev %'");
    // Clerk IDs are shared with other suites — remove attributed photos before
    // the users delete (photos.uploaded_by is NO ACTION).
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

  it("serves published gallery metadata without any auth header — and never the PIN", async () => {
    const res = await request(app).get(`/api/v1/public/galleries/${publishedSlug}`);
    expect(res.status).toBe(200);
    expect(res.body.gallery.name).toMatch(/Customer Gallery/);
    expect(res.body.gallery.event_name).toMatch(/Public Gal Ev/);
    expect(res.body.gallery.event_date).toBe("2026-12-05");
    expect(res.body.gallery.photo_count).toBe(1);
    // Only published galleries are ever served, so status isn't exposed.
    expect(res.body.gallery.status).toBeUndefined();
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(publishedPin);
    expect(body).not.toContain('"pin"');
  });

  it("unknown slug is a 404", async () => {
    const res = await request(app).get("/api/v1/public/galleries/no-such-gallery");
    expect(res.status).toBe(404);
  });

  it("draft galleries 404 on metadata and unlock (no existence leak)", async () => {
    const meta = await request(app).get(`/api/v1/public/galleries/${draftSlug}`);
    expect(meta.status).toBe(404);
    const unlock = await request(app)
      .post(`/api/v1/public/galleries/${draftSlug}/unlock`)
      .send({ pin: "000000" });
    expect(unlock.status).toBe(404);
  });

  it("rejects a malformed PIN before touching the rate limit", async () => {
    const res = await request(app)
      .post(`/api/v1/public/galleries/${publishedSlug}/unlock`)
      .send({ pin: "abc" });
    expect(res.status).toBe(400);
  });

  it("wrong PIN is a 403, correct PIN returns the photos without uploader data", async () => {
    const wrong = await request(app)
      .post(`/api/v1/public/galleries/${publishedSlug}/unlock`)
      .send({ pin: publishedPin === "000000" ? "000001" : "000000" });
    expect(wrong.status).toBe(403);

    const right = await request(app)
      .post(`/api/v1/public/galleries/${publishedSlug}/unlock`)
      .send({ pin: publishedPin });
    expect(right.status).toBe(200);
    expect(right.body.photos).toHaveLength(1);
    // Photos are backend-proxied with a signed token — never storage URLs.
    expect(right.body.photos[0].url).toContain(
      `/api/v1/public/galleries/${publishedSlug}/photos/`
    );
    expect(right.body.photos[0].url).toContain("?st=");
    expect(right.body.photos[0].download_url).toContain("&dl=1");
    expect(right.body.access_token).toBeTruthy();
    expect(right.body.expires_at).toBeTruthy();
    const body = JSON.stringify(right.body);
    expect(body).not.toContain(publishedPin);
    expect(body).not.toContain("appwrite");
    expect(body).not.toContain("uploaded_by");
    expect(body).not.toContain("uploader");
  });

  it("signed token streams the photo; missing or tampered tokens are rejected", async () => {
    const unlock = await request(app)
      .post(`/api/v1/public/galleries/${publishedSlug}/unlock`)
      .send({ pin: publishedPin });
    const photoUrl = unlock.body.photos[0].url as string;
    const downloadUrl = unlock.body.photos[0].download_url as string;

    const ok = await request(app).get(photoUrl);
    expect(ok.status).toBe(200);
    expect(ok.headers["content-type"]).toContain("image/png");
    expect(ok.headers["content-disposition"]).toContain("inline");

    const dl = await request(app).get(downloadUrl);
    expect(dl.status).toBe(200);
    expect(dl.headers["content-disposition"]).toContain("attachment");

    const noToken = await request(app).get(
      `/api/v1/public/galleries/${publishedSlug}/photos/${unlock.body.photos[0].id}`
    );
    expect(noToken.status).toBe(403);

    const tampered = await request(app).get(
      photoUrl.replace(/([?&])st=[^&]*/, "$1st=tampered")
    );
    expect(tampered.status).toBe(403);
  });

  it("a valid token cannot read photos outside the gallery", async () => {
    const other = await request(app)
      .post(`/api/v1/events/${eventId}/photos`)
      .set(adminA)
      .attach("photos", png(), { filename: "outsider.png", contentType: "image/png" });
    const outsiderId = other.body.photos[0].id;

    const unlock = await request(app)
      .post(`/api/v1/public/galleries/${publishedSlug}/unlock`)
      .send({ pin: publishedPin });
    const photoUrl = unlock.body.photos[0].url as string;
    const token = photoUrl.split("st=")[1]!;
    // Same gallery session, different photo — the outsider is NOT in the gallery.
    const res = await request(app)
      .get(`/api/v1/public/galleries/${publishedSlug}/photos/${outsiderId}?st=${token}`);
    expect(res.status).toBe(404);
  });

  it("a successful unlock resets the failure counter", async () => {
    const real = await makeGallery(`Reset Counter ${Date.now()}`, true);
    // Two wrong attempts, then the correct PIN must still unlock.
    await request(app).post(`/api/v1/public/galleries/${real.slug}/unlock`).send({ pin: "000000" });
    await request(app).post(`/api/v1/public/galleries/${real.slug}/unlock`).send({ pin: "000001" });
    const ok = await request(app)
      .post(`/api/v1/public/galleries/${real.slug}/unlock`)
      .send({ pin: real.pin });
    expect(ok.status).toBe(200);
    // And the counter is cleared — the next wrong attempt is 403, not 429.
    const after = await request(app)
      .post(`/api/v1/public/galleries/${real.slug}/unlock`)
      .send({ pin: "000000" });
    expect(after.status).toBe(403);
  });

  it("locks out after 5 wrong attempts — even the correct PIN gets 429", async () => {
    const locked = await makeGallery(`Lockout ${Date.now()}`, true);
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post(`/api/v1/public/galleries/${locked.slug}/unlock`)
        .send({ pin: "000000" });
      expect(res.status).toBe(403);
    }
    const correct = await request(app)
      .post(`/api/v1/public/galleries/${locked.slug}/unlock`)
      .send({ pin: locked.pin });
    expect(correct.status).toBe(429);
  });

  it("metadata endpoint never lists photos", async () => {
    const res = await request(app).get(`/api/v1/public/galleries/${publishedSlug}`);
    expect(res.body.photos).toBeUndefined();
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
  console.warn("TEST_DATABASE_URL not set — skipping public gallery tests");
}
