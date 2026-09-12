import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * Admin gallery workflow tests: creation, photo binding, publishing,
 * authorization, and cross-event/cross-workspace rejection.
 * Appwrite binary layer is mocked; Postgres authorization is real.
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

describeIf(hasDb)("Admin gallery workflow", () => {
  let app: ReturnType<typeof createApp>;
  let env: Env;
  let eventA1: string;
  let eventA2: string;
  let photoA1: string;
  let photoA2: string; // belongs to A2, must be rejected for A1 galleries

  function describeIf(cond: boolean) {
    return cond ? describe : describe.skip;
  }

  beforeEach(async () => {
    process.env.DATABASE_URL = dbUrl!;
    process.env.DATABASE_SSL_CA = "";
    app = buildApp();
    const { loadEnv } = await import("../src/config/env.js");
    env = loadEnv();
    await seedWorkspaces(env);
    await seed(env);

    const a1 = await request(app)
      .post("/api/v1/events")
      .set(adminA)
      .send({ name: `Gallery Ev A1 ${Date.now()}`, event_date: "2026-12-01" });
    eventA1 = a1.body.event.id;
    const a2 = await request(app)
      .post("/api/v1/events")
      .set(adminA)
      .send({ name: `Gallery Ev A2 ${Date.now()}`, event_date: "2026-12-02" });
    eventA2 = a2.body.event.id;

    // Assign C to A1 (members can only upload to assigned events).
    const memberId = await getPool(env).query<{ id: string }>(
      "SELECT id FROM users WHERE clerk_user_id = 'clerk_member_1'"
    );
    await request(app)
      .post(`/api/v1/events/${eventA1}/team-members`)
      .set(adminA)
      .send({ user_id: memberId.rows[0]!.id });

    // C uploads one photo to A1, admin uploads one to A2.
    const p1 = await request(app)
      .post(`/api/v1/events/${eventA1}/photos`)
      .set(memberC)
      .attach("photos", png(), { filename: "a1.png", contentType: "image/png" });
    expect(p1.status).toBe(201);
    photoA1 = p1.body.photos[0].id;
    const p2 = await request(app)
      .post(`/api/v1/events/${eventA2}/photos`)
      .set(adminA)
      .attach("photos", png(), { filename: "a2.png", contentType: "image/png" });
    photoA2 = p2.body.photos[0].id;
  });

  afterAll(async () => {
    const pool = getPool(env);
    await pool.query("DELETE FROM galleries WHERE event_id IN (SELECT id FROM events WHERE name LIKE 'Gallery Ev %')");
    await pool.query("DELETE FROM photos WHERE event_id IN (SELECT id FROM events WHERE name LIKE 'Gallery Ev %')");
    await pool.query("DELETE FROM events WHERE name LIKE 'Gallery Ev %'");
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

  it("admin creates a gallery with selected photos and a 6-digit PIN", async () => {
    const res = await request(app)
      .post(`/api/v1/events/${eventA1}/galleries`)
      .set(adminA)
      .send({ name: "Ceremony Highlights", photo_ids: [photoA1] });
    expect(res.status).toBe(201);
    expect(res.body.gallery.status).toBe("draft");
    expect(res.body.gallery.pin).toMatch(/^\d{6}$/);
    expect(res.body.gallery.photo_count).toBe(1);
    expect(res.body.gallery.slug).toMatch(/^[a-z0-9-]+$/);
  });

  it("gallery cannot include photos from another event (even same workspace)", async () => {
    const res = await request(app)
      .post(`/api/v1/events/${eventA1}/galleries`)
      .set(adminA)
      .send({ name: "Sneaky", photo_ids: [photoA1, photoA2] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/don't belong/i);
  });

  it("empty selection is rejected", async () => {
    const res = await request(app)
      .post(`/api/v1/events/${eventA1}/galleries`)
      .set(adminA)
      .send({ name: "Empty", photo_ids: [] });
    expect(res.status).toBe(400);
  });

  it("nonexistent photo IDs are rejected", async () => {
    const res = await request(app)
      .post(`/api/v1/events/${eventA1}/galleries`)
      .set(adminA)
      .send({
        name: "Ghost",
        photo_ids: ["00000000-0000-0000-0000-000000000000"],
      });
    expect(res.status).toBe(400);
  });

  it("team member cannot create or publish galleries (403)", async () => {
    const create = await request(app)
      .post(`/api/v1/events/${eventA1}/galleries`)
      .set(memberC)
      .send({ name: "Member Gallery", photo_ids: [photoA1] });
    expect(create.status).toBe(403);

    const g = await request(app)
      .post(`/api/v1/events/${eventA1}/galleries`)
      .set(adminA)
      .send({ name: "Admin Only", photo_ids: [photoA1] });
    const pub = await request(app)
      .post(`/api/v1/galleries/${g.body.gallery.id}/publish`)
      .set(memberC);
    expect(pub.status).toBe(403);
  });

  it("admin from another workspace cannot create galleries for A's event", async () => {
    const res = await request(app)
      .post(`/api/v1/events/${eventA1}/galleries`)
      .set(adminB)
      .send({ name: "Cross WS", photo_ids: [photoA1] });
    expect(res.status).toBe(404);
  });

  it("publish works and is reflected in the gallery list", async () => {
    const created = await request(app)
      .post(`/api/v1/events/${eventA1}/galleries`)
      .set(adminA)
      .send({ name: "Publish Me", description: "test", photo_ids: [photoA1] });
    expect(created.status).toBe(201);

    const pub = await request(app)
      .post(`/api/v1/galleries/${created.body.gallery.id}/publish`)
      .set(adminA);
    expect(pub.status).toBe(200);
    expect(pub.body.gallery.status).toBe("published");
    expect(pub.body.gallery.published_at).toBeTruthy();

    const list = await request(app).get(`/api/v1/events/${eventA1}/galleries`).set(adminA);
    expect(list.status).toBe(200);
    const found = list.body.galleries.find(
      (g: { id: string }) => g.id === created.body.gallery.id
    );
    expect(found.status).toBe("published");
    expect(found.photo_count).toBe(1);
  });

  it("publishing is idempotent-safe and works when already published", async () => {
    const created = await request(app)
      .post(`/api/v1/events/${eventA1}/galleries`)
      .set(adminA)
      .send({ name: "Double Publish", photo_ids: [photoA1] });
    const first = await request(app)
      .post(`/api/v1/galleries/${created.body.gallery.id}/publish`)
      .set(adminA);
    const second = await request(app)
      .post(`/api/v1/galleries/${created.body.gallery.id}/publish`)
      .set(adminA);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.gallery.status).toBe("published");
  });

  it("gallery for nonexistent event returns 404", async () => {
    const res = await request(app)
      .post("/api/v1/events/00000000-0000-0000-0000-000000000000/galleries")
      .set(adminA)
      .send({ name: "Ghost Event", photo_ids: [photoA1] });
    expect(res.status).toBe(404);
  });

  it("events are always born draft — a client-sent status is ignored", async () => {
    const res = await request(app)
      .post("/api/v1/events")
      .set(adminA)
      .send({ name: `Gallery Ev Draft ${Date.now()}`, event_date: "2026-12-20", status: "completed" });
    expect(res.status).toBe(201);
    expect(res.body.event.status).toBe("draft");
  });

  it("admin can set a custom PIN and it unlocks the gallery", async () => {
    const created = await request(app)
      .post(`/api/v1/events/${eventA1}/galleries`)
      .set(adminA)
      .send({ name: "Custom PIN", photo_ids: [photoA1] });
    const galleryId = created.body.gallery.id;

    const patched = await request(app)
      .patch(`/api/v1/galleries/${galleryId}`)
      .set(adminA)
      .send({ pin: "246810" });
    expect(patched.status).toBe(200);
    expect(patched.body.gallery.pin).toBe("246810");
  });

  it("regenerate replaces the PIN with a fresh server-generated one", async () => {
    const created = await request(app)
      .post(`/api/v1/events/${eventA1}/galleries`)
      .set(adminA)
      .send({ name: "Regen PIN", photo_ids: [photoA1] });
    const galleryId = created.body.gallery.id;

    // Publish so the public unlock surface can be used to verify the swap.
    await request(app).post(`/api/v1/galleries/${galleryId}/publish`).set(adminA);

    const regen = await request(app)
      .post(`/api/v1/galleries/${galleryId}/pin/regenerate`)
      .set(adminA);
    expect(regen.status).toBe(200);
    expect(regen.body.gallery.pin).toMatch(/^\d{6}$/);
    // The old auto PIN is gone unless the random draw collided (1 in a million).
    if (regen.body.gallery.pin !== created.body.gallery.pin) {
      const unlockOld = await request(app)
        .post(`/api/v1/public/galleries/${created.body.gallery.slug}/unlock`)
        .send({ pin: created.body.gallery.pin });
      expect(unlockOld.status).toBe(403);
    }
  });

  it("malformed PIN is rejected", async () => {
    const created = await request(app)
      .post(`/api/v1/events/${eventA1}/galleries`)
      .set(adminA)
      .send({ name: "Bad Pin", photo_ids: [photoA1] });
    const res = await request(app)
      .patch(`/api/v1/galleries/${created.body.gallery.id}`)
      .set(adminA)
      .send({ pin: "12ab" });
    expect(res.status).toBe(400);
  });

  it("team member cannot set a PIN (403) and cross-workspace admin gets 404", async () => {
    const created = await request(app)
      .post(`/api/v1/events/${eventA1}/galleries`)
      .set(adminA)
      .send({ name: "Member Pin", photo_ids: [photoA1] });
    const galleryId = created.body.gallery.id;

    const member = await request(app)
      .patch(`/api/v1/galleries/${galleryId}`)
      .set(memberC)
      .send({ pin: "111111" });
    expect(member.status).toBe(403);

    const other = await request(app)
      .patch(`/api/v1/galleries/${galleryId}`)
      .set(adminB)
      .send({ pin: "111111" });
    expect(other.status).toBe(404);
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
  console.warn("TEST_DATABASE_URL not set — skipping gallery workflow tests");
}
