import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * Phase 3 queue tests: producer identity/policy, publish-failure fallback,
 * reconciler recovery, worker processor, and the admin queue endpoint.
 *
 * BullMQ/ioredis are mocked (no Redis in CI); Postgres is real. The fallback
 * path (no REDIS_URL) runs the genuine in-process sweep, and the worker
 * processor runs against real rows.
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
      createInvitation: vi.fn(async () => ({ id: "inv_q", status: "pending" })),
    },
  })),
}));

vi.mock("../src/lib/storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/storage.js")>();
  const { default: sharp } = await import("sharp");
  const validPng = await sharp({
    create: { width: 320, height: 240, channels: 3, background: { r: 4, g: 44, b: 144 } },
  })
    .png()
    .toBuffer();
  return {
    ...actual,
    uploadPhoto: vi.fn(async (_e: unknown, b: Buffer, _m: string, _n: string) => ({
      storageFileId: `aw_q_${Math.random().toString(36).slice(2, 10)}`,
      size: b.byteLength,
    })),
    deletePhotoQuietly: vi.fn(async () => undefined),
    checkBucket: vi.fn(async () => true),
    readPhotoBytes: vi.fn(async () => validPng),
  };
});

vi.mock("bullmq", () => ({
  Queue: class {
    name: string;
    constructor(name: string, opts: unknown) {
      this.name = name;
      (globalThis as Record<string, unknown>).__qCtor = { name, opts };
    }
    async add(name: string, data: unknown, opts: unknown) {
      const g = globalThis as Record<string, unknown>;
      if (g.__qFailNext) {
        g.__qFailNext = false;
        throw new Error("Redis is down");
      }
      if (!Array.isArray(g.__qPublished)) g.__qPublished = [];
      (g.__qPublished as unknown[]).push({ name, data, opts });
      return { id: (opts as { jobId?: string }).jobId ?? "x" };
    }
    async getJobCounts() {
      const g = globalThis as Record<string, unknown>;
      if (g.__qCountsFail) throw new Error("connection refused");
      const published = ((g.__qPublished as unknown[]) ?? []).length;
      return { waiting: published, active: 0, failed: 0 };
    }
    async close() {}
  },
  Worker: class {
    constructor() {}
    on() {}
    async close() {}
  },
}));

vi.mock("ioredis", () => ({
  Redis: class {
    on() {}
    async quit() {}
  },
}));

import { createApp } from "../src/server.js";
import { resetEnvCache } from "../src/config/env.js";
import { closePool, getPool, insertPhoto } from "../src/lib/db.js";
import {
  derivativeJobId,
  publishDerivativeJobs,
  reconcileDerivativeJobs,
} from "../src/lib/derivative-jobs.js";
import { getPhotoDerivatives, processDerivativeJob } from "../src/lib/derivatives.js";
import { isQueueConfigured, resetQueueState } from "../src/lib/queue.js";
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

const adminA = { Authorization: "Bearer valid.clerk_q_admin" };
const memberA = { Authorization: "Bearer valid.clerk_q_member" };

function publishedJobs(): { name: string; data: { photoId: string; variant: string }; opts: { jobId: string } }[] {
  return ((globalThis as Record<string, unknown>).__qPublished as never[]) ?? [];
}

function clearPublished() {
  (globalThis as Record<string, unknown>).__qPublished = [];
}

function pngUpload(): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([header, Buffer.alloc(60)]);
}

describeIf(hasDb)("Queue producer (mocked BullMQ)", () => {
  let app: ReturnType<typeof createApp>;
  let env: Env;
  let eventId: string;

  beforeEach(async () => {
    process.env.DATABASE_URL = dbUrl!;
    process.env.DATABASE_SSL_CA = "";
    process.env.REDIS_URL = "redis://localhost:6379";
    clearPublished();
    resetQueueState();
    app = buildApp();
    const { loadEnv } = await import("../src/config/env.js");
    env = loadEnv();
    expect(isQueueConfigured(env)).toBe(true);
    await seed(env);
    const created = await request(app)
      .post("/api/v1/events")
      .set(adminA)
      .send({ name: `Q Event ${Date.now()}`, event_date: "2026-12-01" });
    eventId = created.body.event.id;
    await request(app)
      .post(`/api/v1/events/${eventId}/team-members`)
      .set(adminA)
      .send({ user_id: await userIdOf("clerk_q_member") });
  });

  afterAll(async () => {
    delete process.env.REDIS_URL;
    resetQueueState();
    await cleanup(env);
    await closePool();
  });

  async function userIdOf(clerkId: string): Promise<string> {
    const r = await getPool(env).query<{ id: string }>(
      "SELECT id FROM users WHERE clerk_user_id = $1",
      [clerkId]
    );
    return r.rows[0]!.id;
  }

  it("publishes stable job identities with the retry/backoff policy", async () => {
    const res = await request(app)
      .post(`/api/v1/events/${eventId}/photos`)
      .set(memberA)
      .attach("photos", pngUpload(), { filename: "q.png", contentType: "image/png" });
    expect(res.status).toBe(201);
    const photoId = res.body.photos[0].id as string;

    const jobs = publishedJobs();
    expect(jobs.length).toBe(2);
    expect(jobs.map((j) => j.name)).toEqual(["derivative", "derivative"]);
    expect(jobs.map((j) => j.opts.jobId).sort()).toEqual(
      [`dv:${photoId}:thumb_large`, `dv:${photoId}:thumb_small`].sort()
    );
    expect(derivativeJobId(photoId, "thumb_small")).toBe(`dv:${photoId}:thumb_small`);

    const ctor = (globalThis as Record<string, unknown>).__qCtor as {
      name: string;
      opts: { defaultJobOptions: Record<string, unknown> };
    };
    expect(ctor.name).toBe("frameflow-derivatives");
    expect(ctor.opts.defaultJobOptions).toMatchObject({
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    });
  });

  it("duplicate publishes reuse the same identity (no duplicate work)", async () => {
    const first = await publishDerivativeJobs(env, "11111111-1111-1111-1111-111111111111");
    const second = await publishDerivativeJobs(env, "11111111-1111-1111-1111-111111111111");
    expect(first.published).toBe(true);
    expect(second.published).toBe(true);
    const ids = publishedJobs().map((j) => j.opts.jobId);
    expect(new Set(ids).size).toBe(2);
  });

  it("reconciler republishes rows left QUEUED (e.g. created during outage)", async () => {
    const res = await request(app)
      .post(`/api/v1/events/${eventId}/photos`)
      .set(memberA)
      .attach("photos", pngUpload(), { filename: "q.png", contentType: "image/png" });
    const photoId = res.body.photos[0].id as string;
    clearPublished();

    const result = await reconcileDerivativeJobs(env);
    // Other tests in this file also leave QUEUED rows (no worker runs here),
    // so the reconciler picks those up too — assert ours are included.
    expect(result.published).toBeGreaterThanOrEqual(2);
    const ids = publishedJobs().map((j) => j.opts.jobId);
    expect(ids).toContain(`dv:${photoId}:thumb_small`);
    expect(ids).toContain(`dv:${photoId}:thumb_large`);
  });

  it("publish failure keeps the upload green and recovers via fallback", async () => {
    (globalThis as Record<string, unknown>).__qFailNext = true;
    // First add throws; the route falls back to the in-process sweep.
    const res = await request(app)
      .post(`/api/v1/events/${eventId}/photos`)
      .set(memberA)
      .attach("photos", pngUpload(), { filename: "q.png", contentType: "image/png" });
    expect(res.status).toBe(201);
    const photoId = res.body.photos[0].id as string;

    // Fallback sweep drains the rows despite Redis being down.
    const { sweepDerivativeQueue } = await import("../src/lib/derivatives.js");
    const start = Date.now();
    for (;;) {
      const rows = await getPhotoDerivatives(env, photoId);
      if (rows.length > 0 && rows.every((r) => r.status === "READY" || r.status === "FAILED"))
        break;
      if (Date.now() - start > 15_000) throw new Error("unsettleable");
      await sweepDerivativeQueue(env).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 200));
    }
    const rows = await getPhotoDerivatives(env, photoId);
    expect(rows.map((r) => r.status)).toEqual(["READY", "READY"]);
  });
});

describeIf(hasDb)("Queue fallback + worker processor (no Redis)", () => {
  let app: ReturnType<typeof createApp>;
  let env: Env;
  let eventId: string;

  beforeEach(async () => {
    process.env.DATABASE_URL = dbUrl!;
    process.env.DATABASE_SSL_CA = "";
    delete process.env.REDIS_URL;
    resetQueueState();
    app = buildApp();
    const { loadEnv } = await import("../src/config/env.js");
    env = loadEnv();
    expect(isQueueConfigured(env)).toBe(false);
    await seed(env);
    const created = await request(app)
      .post("/api/v1/events")
      .set(adminA)
      .send({ name: `QFB Event ${Date.now()}`, event_date: "2026-12-01" });
    eventId = created.body.event.id;
    await request(app)
      .post(`/api/v1/events/${eventId}/team-members`)
      .set(adminA)
      .send({ user_id: await userIdOf("clerk_q_member") });
  });

  afterAll(async () => {
    await cleanup(env);
  });

  async function userIdOf(clerkId: string): Promise<string> {
    const r = await getPool(env).query<{ id: string }>(
      "SELECT id FROM users WHERE clerk_user_id = $1",
      [clerkId]
    );
    return r.rows[0]!.id;
  }

  async function settle(photoId: string, timeoutMs = 15_000): Promise<void> {
    const { sweepDerivativeQueue } = await import("../src/lib/derivatives.js");
    const start = Date.now();
    for (;;) {
      const rows = await getPhotoDerivatives(env, photoId);
      if (rows.length > 0 && rows.every((r) => r.status === "READY" || r.status === "FAILED"))
        return;
      if (Date.now() - start > timeoutMs) throw new Error("unsettleable");
      await sweepDerivativeQueue(env).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  it("processes uploads end to end without Redis", async () => {
    const res = await request(app)
      .post(`/api/v1/events/${eventId}/photos`)
      .set(memberA)
      .attach("photos", pngUpload(), { filename: "q.png", contentType: "image/png" });
    expect(res.status).toBe(201);
    const photoId = res.body.photos[0].id as string;
    await settle(photoId);
    const rows = await getPhotoDerivatives(env, photoId);
    expect(rows.map((r) => r.status)).toEqual(["READY", "READY"]);
  });

  it("worker processor completes one job and skips READY rows", async () => {
    // Direct DB insert: no route runs, so no background sweep can race this.
    const photo = await insertPhoto(env, {
      event_id: eventId,
      uploaded_by: await userIdOf("clerk_q_member"),
      filename: "direct.png",
      storage_file_id: `aw_direct_${Date.now()}`,
      mime_type: "image/png",
      file_size: 100,
    });
    const { enqueuePhotoDerivatives } = await import("../src/lib/derivatives.js");
    await enqueuePhotoDerivatives(env, photo.id);

    const first = await processDerivativeJob(env, { photoId: photo.id, variant: "thumb_small" });
    expect(first.outcome).toBe("ready");
    const second = await processDerivativeJob(env, { photoId: photo.id, variant: "thumb_small" });
    expect(second.outcome).toBe("skipped");
  });

  it("queue endpoint reports unconfigured without Redis (admin only)", async () => {
    const ok = await request(app).get("/api/v1/queues/derivatives").set(adminA);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ configured: false });
    const member = await request(app).get("/api/v1/queues/derivatives").set(memberA);
    expect(member.status).toBe(403);
    const anon = await request(app).get("/api/v1/queues/derivatives");
    expect(anon.status).toBe(401);
  });

  it("queue endpoint 503s without leaking the URL when Redis is down", async () => {
    // The app boots its env at buildApp(); re-point it at Redis for this call.
    process.env.REDIS_URL = "redis://localhost:6379";
    resetEnvCache();
    resetQueueState();
    (globalThis as Record<string, unknown>).__qCountsFail = true;
    const appWithRedis = buildApp();
    const res = await request(appWithRedis).get("/api/v1/queues/derivatives").set(adminA);
    (globalThis as Record<string, unknown>).__qCountsFail = false;
    delete process.env.REDIS_URL;
    resetEnvCache();
    resetQueueState();
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "Queue unavailable" });
  });
});

async function seed(env: Env) {
  const pool = getPool(env);
  for (const name of ["WS-q-a", "WS-q-b"]) {
    await pool.query(
      `INSERT INTO workspaces (name) SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM workspaces WHERE name = $1)`,
      [name]
    );
  }
  await pool.query(
    `INSERT INTO users (clerk_user_id, name, email, role, workspace_id) VALUES
       ('clerk_q_admin', 'Q Admin', 'q_admin@frameflow.test', 'ADMIN',
         (SELECT id FROM workspaces WHERE name = 'WS-q-a')),
       ('clerk_q_member', 'Q Member', 'q_member@frameflow.test', 'TEAM_MEMBER',
         (SELECT id FROM workspaces WHERE name = 'WS-q-a')),
       ('clerk_q_admin_b', 'Q Admin B', 'q_admin_b@frameflow.test', 'ADMIN',
         (SELECT id FROM workspaces WHERE name = 'WS-q-b'))
     ON CONFLICT (clerk_user_id) DO NOTHING`
  );
}

async function cleanup(env: Env) {
  const pool = getPool(env);
  await pool.query(
    `DELETE FROM photos WHERE uploaded_by IN
     (SELECT id FROM users WHERE clerk_user_id LIKE 'clerk_q_%')`
  );
  await pool.query("DELETE FROM events WHERE name LIKE 'Q Event %' OR name LIKE 'QFB Event %'");
  await pool.query(
    `DELETE FROM event_team_members WHERE user_id IN
     (SELECT id FROM users WHERE clerk_user_id LIKE 'clerk_q_%')`
  );
  await pool.query(
    `UPDATE workspaces SET created_by = NULL
     WHERE created_by IN (SELECT id FROM users WHERE clerk_user_id LIKE 'clerk_q_%')`
  );
  await pool.query(
    `DELETE FROM users WHERE clerk_user_id IN ('clerk_q_admin','clerk_q_member','clerk_q_admin_b')`
  );
  await pool.query(`DELETE FROM workspaces WHERE name IN ('WS-q-a','WS-q-b')`);
}

if (!hasDb) {
  console.warn("TEST_DATABASE_URL not set — skipping queue tests");
}
