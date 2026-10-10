import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * Phase 3 photo tests: authorization, workspace isolation, upload
 * validation, and uploaded_by server-derivation.
 *
 * Appwrite is mocked (binary storage is external); Postgres authorization
 * and metadata logic run against the real database.
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
      createInvitation: vi.fn(async () => ({ id: "inv_test", status: "pending" })),
    },
  })),
}));

// Appwrite Storage — track uploads/deletes so consistency can be asserted.
let uploadCounter = 0;
const appwriteFiles = new Map<string, number>();
vi.mock("../src/lib/storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/storage.js")>();
  // Hermetic derivative sweeps: uploads kick the background worker, which
  // reads originals — serve a tiny valid PNG so no test hits the network.
  const { default: sharp } = await import("sharp");
  const tinyPng = await sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 1, g: 2, b: 3 } },
  })
    .png()
    .toBuffer();
  return {
    ...actual,
    uploadPhoto: vi.fn(async (_env: unknown, buffer: Buffer, _mime: string, _name: string) => {
      uploadCounter += 1;
      const id = `aw_${uploadCounter}_${Date.now()}`;
      appwriteFiles.set(id, buffer.byteLength);
      return { storageFileId: id, size: buffer.byteLength };
    }),
    deletePhotoQuietly: vi.fn(async (_env: unknown, storageFileId: string) => {
      appwriteFiles.delete(storageFileId);
    }),
    checkBucket: vi.fn(async () => true),
    readPhotoBytes: vi.fn(async () => tinyPng),
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

const adminAToken = "valid.clerk_admin_1";
const memberCToken = "valid.clerk_member_1";
const adminBToken = "valid.clerk_admin_2";
const memberDToken = "valid.clerk_member_d";
const adminA = { Authorization: `Bearer ${adminAToken}` };
const memberC = { Authorization: `Bearer ${memberCToken}` };
const adminB = { Authorization: `Bearer ${adminBToken}` };
const memberD = { Authorization: `Bearer ${memberDToken}` };

function pngBuffer(bytes = 100): Buffer {
  // Minimal valid-looking PNG header + padding.
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([header, Buffer.alloc(bytes)]);
}

describeIf(hasDb)("Phase 3 photos", () => {
  let app: ReturnType<typeof createApp>;
  let env: Env;
  let eventA1: string;
  let eventB1: string;
  let memberDId: string;

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
    appwriteFiles.clear();

    const a = await request(app)
      .post("/api/v1/events")
      .set(adminA)
      .send({ name: `WS-A Event ${Date.now()}`, event_date: "2026-12-01" });
    eventA1 = a.body.event.id;

    const b = await request(app)
      .post("/api/v1/events")
      .set(adminB)
      .send({ name: `WS-B Event ${Date.now()}`, event_date: "2026-12-02" });
    eventB1 = b.body.event.id;

    // Assign C to A1, D to B1.
    await request(app)
      .post(`/api/v1/events/${eventA1}/team-members`)
      .set(adminA)
      .send({ user_id: await userIdOf("clerk_member_1") });
    memberDId = await userIdOf("clerk_member_d");
    await request(app)
      .post(`/api/v1/events/${eventB1}/team-members`)
      .set(adminB)
      .send({ user_id: memberDId });
  });

  afterAll(async () => {
    const pool = getPool(env);
    await pool.query(
      `DELETE FROM photos WHERE event_id IN
       (SELECT id FROM events WHERE name LIKE 'WS-% Event %')
       OR uploaded_by IN (SELECT id FROM users WHERE clerk_user_id LIKE 'clerk_%')`
    );
    await pool.query("DELETE FROM events WHERE name LIKE 'WS-% Event %'");
    await pool.query(
      `DELETE FROM invitations WHERE invited_by IN
       (SELECT id FROM users WHERE clerk_user_id LIKE 'clerk_%')`
    );
    await pool.query(
      `DELETE FROM event_team_members WHERE user_id IN
       (SELECT id FROM users WHERE clerk_user_id LIKE 'clerk_%')`
    );
    await pool.query(
      `UPDATE workspaces SET created_by = NULL
       WHERE created_by IN (SELECT id FROM users WHERE clerk_user_id LIKE 'clerk_%')`
    );
    await pool.query(
      `DELETE FROM users WHERE clerk_user_id IN
       ('clerk_admin_1','clerk_member_1','clerk_admin_2','clerk_member_d')`
    );
    await pool.query(
      `DELETE FROM workspaces WHERE name IN
       ('WS-admin@frameflow.test','WS-admin2@frameflow.test','WS-memberD')`
    );
    await closePool();
  });

  it("401 for unauthenticated photo list", async () => {
    const res = await request(app).get(`/api/v1/events/${eventA1}/photos`);
    expect(res.status).toBe(401);
  });

  it("team member C uploads to assigned event A1 (allowed)", async () => {
    const res = await request(app)
      .post(`/api/v1/events/${eventA1}/photos`)
      .set(memberC)
      .attach("photos", pngBuffer(), { filename: "shot.png", contentType: "image/png" });
    expect(res.status).toBe(201);
    expect(res.body.photos.length).toBe(1);
    expect(appwriteFiles.size).toBe(1); // binary reached Appwrite

    // Metadata in Postgres with server-derived uploaded_by.
    const rows = await getPool(env).query(
      "SELECT uploaded_by, filename, mime_type FROM photos WHERE event_id = $1",
      [eventA1]
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]!.uploaded_by).toBe(await userIdOf("clerk_member_1"));
    expect(rows.rows[0]!.filename).toBe("shot.png");
  });

  it("uploaded_by spoofing is ignored — server uses the authenticated user", async () => {
    const adminAId = await userIdOf("clerk_admin_1");
    const res = await request(app)
      .post(`/api/v1/events/${eventA1}/photos`)
      .set(memberC)
      .attach("photos", pngBuffer(), { filename: "spooky.png", contentType: "image/png" })
      .field("uploaded_by", adminAId) // attacker tries to claim admin uploaded it
      .field("userId", adminAId);
    expect(res.status).toBe(201);
    const rows = await getPool(env).query<{ uploaded_by: string }>(
      "SELECT uploaded_by FROM photos WHERE event_id = $1",
      [eventA1]
    );
    expect(rows.rows[0]!.uploaded_by).toBe(await userIdOf("clerk_member_1"));
    expect(rows.rows[0]!.uploaded_by).not.toBe(adminAId);
  });

  it("team member C cannot upload to unassigned event A2", async () => {
    const a2 = await request(app)
      .post("/api/v1/events")
      .set(adminA)
      .send({ name: `WS-A Event2 ${Date.now()}`, event_date: "2026-12-05" });
    const res = await request(app)
      .post(`/api/v1/events/${a2.body.event.id}/photos`)
      .set(memberC)
      .attach("photos", pngBuffer(), { filename: "x.png", contentType: "image/png" });
    expect(res.status).toBe(403);
    await getPool(env).query("DELETE FROM events WHERE id = $1", [a2.body.event.id]);
  });

  it("cross-workspace: C cannot upload to or view B1", async () => {
    const up = await request(app)
      .post(`/api/v1/events/${eventB1}/photos`)
      .set(memberC)
      .attach("photos", pngBuffer(), { filename: "x.png", contentType: "image/png" });
    expect(up.status).toBe(404); // B1 is invisible from workspace A

    const list = await request(app).get(`/api/v1/events/${eventB1}/photos`).set(memberC);
    expect(list.status).toBe(404);
  });

  it("cross-workspace: admin A cannot view or delete B1's photos", async () => {
    // D uploads to B1.
    const up = await request(app)
      .post(`/api/v1/events/${eventB1}/photos`)
      .set(memberD)
      .attach("photos", pngBuffer(), { filename: "d.png", contentType: "image/png" });
    expect(up.status).toBe(201);

    const list = await request(app).get(`/api/v1/events/${eventB1}/photos`).set(adminA);
    expect(list.status).toBe(404);

    const photosInB1 = await getPool(env).query<{ id: string }>(
      "SELECT id FROM photos WHERE event_id = $1",
      [eventB1]
    );
    expect(photosInB1.rowCount).toBe(1);
    const del = await request(app)
      .delete(`/api/v1/photos/${photosInB1.rows[0]!.id}`)
      .set(adminA);
    expect(del.status).toBe(404);
    // Photo must still exist in Postgres (not deleted by cross-tenant admin).
    const still = await getPool(env).query(
      "SELECT 1 FROM photos WHERE id = $1",
      [photosInB1.rows[0]!.id]
    );
    expect(still.rowCount).toBe(1);
  });

  it("multi-tenant matrix: D uploads to B1 but cannot upload to A1", async () => {
    const ok = await request(app)
      .post(`/api/v1/events/${eventB1}/photos`)
      .set(memberD)
      .attach("photos", pngBuffer(), { filename: "d.png", contentType: "image/png" });
    expect(ok.status).toBe(201);

    const no = await request(app)
      .post(`/api/v1/events/${eventA1}/photos`)
      .set(memberD)
      .attach("photos", pngBuffer(), { filename: "d.png", contentType: "image/png" });
    expect(no.status).toBe(404);
  });

  it("invalid MIME type is rejected with 400", async () => {
    const res = await request(app)
      .post(`/api/v1/events/${eventA1}/photos`)
      .set(memberC)
      .attach("photos", Buffer.from("not an image"), {
        filename: "evil.pdf",
        contentType: "application/pdf",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unsupported file type/i);
  });

  it("admin A can view and delete photos of A1", async () => {
    await request(app)
      .post(`/api/v1/events/${eventA1}/photos`)
      .set(memberC)
      .attach("photos", pngBuffer(), { filename: "c.png", contentType: "image/png" });

    const list = await request(app).get(`/api/v1/events/${eventA1}/photos`).set(adminA);
    expect(list.status).toBe(200);
    expect(list.body.photos.length).toBe(1);
    expect(list.body.photos[0].url).toContain("/files/");

    const photoId = list.body.photos[0].id;
    const del = await request(app).delete(`/api/v1/photos/${photoId}`).set(adminA);
    expect(del.status).toBe(204);
    // Appwrite object removed too (consistency).
    expect(appwriteFiles.size).toBe(0);
  });

  it("upload with no files returns 400", async () => {
    const res = await request(app)
      .post(`/api/v1/events/${eventA1}/photos`)
      .set(memberC);
    expect(res.status).toBe(400);
  });

  async function userIdOf(clerkId: string): Promise<string> {
    const pool = getPool(env);
    const r = await pool.query<{ id: string }>("SELECT id FROM users WHERE clerk_user_id = $1", [
      clerkId,
    ]);
    return r.rows[0]!.id;
  }
});

async function seedWorkspaces(env: Env) {
  const pool = getPool(env);
  for (const name of ["WS-admin@frameflow.test", "WS-admin2@frameflow.test", "WS-memberD"]) {
    await pool.query(
      `INSERT INTO workspaces (name) SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM workspaces WHERE name = $1)`,
      [name]
    );
  }
}

async function seed(env: Env) {
  const pool = getPool(env);
  // Workspace A: admin_1 + member C. Workspace B: admin_2 + member D.
  await pool.query(
    `INSERT INTO users (clerk_user_id, name, email, role, workspace_id) VALUES
       ('clerk_admin_1', 'Demo Admin', 'admin@frameflow.test', 'ADMIN',
         (SELECT id FROM workspaces WHERE name = 'WS-admin@frameflow.test')),
       ('clerk_member_1', 'Member C', 'member@frameflow.test', 'TEAM_MEMBER',
         (SELECT id FROM workspaces WHERE name = 'WS-admin@frameflow.test')),
       ('clerk_admin_2', 'Admin B', 'admin2@frameflow.test', 'ADMIN',
         (SELECT id FROM workspaces WHERE name = 'WS-admin2@frameflow.test')),
       ('clerk_member_d', 'Member D', 'memberd@frameflow.test', 'TEAM_MEMBER',
         (SELECT id FROM workspaces WHERE name = 'WS-admin2@frameflow.test'))
     ON CONFLICT (clerk_user_id) DO NOTHING`
  );
}

function describeIf(cond: boolean) {
  return cond ? describe : describe.skip;
}

if (!hasDb) {
  console.warn("TEST_DATABASE_URL not set — skipping Phase 3 photo tests");
}
