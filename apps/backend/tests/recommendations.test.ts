import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * Phase 10 recommendation baseline: deterministic scorer contract (pins,
 * capped popularity, capture bursts, cold-start recency, full tie-break
 * stability), the offline evaluation dataset thresholds, the admin-only
 * workspace-scoped photo-recommendations endpoint, and the workspace-scoped
 * admin picks (photo-picks) that feed it. Draft galleries must never
 * appear in any recommendation payload.
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
      createInvitation: vi.fn(async () => ({ id: "inv_reco", status: "pending" })),
    },
  })),
}));

vi.mock("../src/lib/storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/storage.js")>();
  return {
    ...actual,
    uploadPhoto: vi.fn(async (_e: unknown, b: Buffer) => ({
      storageFileId: `aw_reco_${Math.random().toString(36).slice(2, 10)}`,
      size: b.byteLength,
    })),
    deletePhotoQuietly: vi.fn(async () => undefined),
    checkBucket: vi.fn(async () => true),
  };
});

import { readFileSync } from "node:fs";
import { createApp } from "../src/server.js";
import { resetEnvCache } from "../src/config/env.js";
import { closePool, getPool } from "../src/lib/db.js";
import {
  RECO_BURST_WEIGHT,
  RECO_PIN_WEIGHT,
  RECO_POPULARITY_CAP,
  scorePhotoRecommendations,
  type RecommendationSignals,
} from "../src/lib/recommendations.js";
import { evaluateRecoDataset, parseRecoDataset } from "../src/lib/reco-eval.js";
import { makePhotoViewed } from "../src/lib/analytics-events.js";
import { processAnalyticsRecord } from "../src/lib/analytics-sink.js";
import type { Env } from "../src/config/env.js";

// ---------------------------------------------------------------------------
// Pure scorer contract (no database required)
// ---------------------------------------------------------------------------

function signal(overrides: Partial<RecommendationSignals> & { photoId: string }): RecommendationSignals {
  return {
    uploadedBy: "member-a",
    uploadedAt: "2026-10-01T10:00:00.000Z",
    views: 0,
    downloads: 0,
    pinned: false,
    ...overrides,
  };
}

describe("recommendation scorer", () => {
  it("pins dominate any amount of popularity, and the popularity cap holds", () => {
    const scored = scorePhotoRecommendations([
      signal({ photoId: "hot", views: 500, downloads: 100 }),
      signal({ photoId: "pin", pinned: true, uploadedAt: "2020-01-01T00:00:00.000Z" }),
    ]);
    expect(scored.map((s) => s.photoId)).toEqual(["pin", "hot"]);
    expect(scored[0]!.score).toBe(RECO_PIN_WEIGHT);
    expect(scored[1]!.score).toBe(RECO_POPULARITY_CAP);
    expect(scored[1]!.reasons).toEqual(["popular"]);
  });

  it("popularity = views + 2 x downloads", () => {
    const scored = scorePhotoRecommendations([
      signal({ photoId: "views", views: 10, uploadedBy: "member-v" }),
      signal({ photoId: "downloads", downloads: 5, uploadedBy: "member-d" }),
      signal({ photoId: "mixed", views: 1, downloads: 2, uploadedBy: "member-m" }),
    ]);
    const byId = new Map(scored.map((s) => [s.photoId, s.score]));
    expect(byId.get("views")).toBe(10);
    expect(byId.get("downloads")).toBe(10);
    expect(byId.get("mixed")).toBe(5);
  });

  it("groups capture bursts only for 3+ photos within 2 minutes", () => {
    const scored = scorePhotoRecommendations([
      signal({ photoId: "b1", uploadedBy: "member-c", uploadedAt: "2026-10-05T10:00:00.000Z" }),
      signal({ photoId: "b2", uploadedBy: "member-c", uploadedAt: "2026-10-05T10:01:00.000Z" }),
      signal({ photoId: "b3", uploadedBy: "member-c", uploadedAt: "2026-10-05T10:02:00.000Z" }),
      // Pair only: one neighbour never counts as a burst.
      signal({ photoId: "pair", uploadedBy: "member-d", uploadedAt: "2026-10-05T11:00:00.000Z" }),
      signal({ photoId: "pair2", uploadedBy: "member-d", uploadedAt: "2026-10-05T11:01:00.000Z" }),
      // 121 seconds away: outside the window.
      signal({ photoId: "late", uploadedBy: "member-c", uploadedAt: "2026-10-05T10:04:01.000Z" }),
    ]);
    const byId = new Map(scored.map((s) => [s.photoId, s]));
    for (const id of ["b1", "b2", "b3"]) {
      expect(byId.get(id)!.reasons).toContain("same_burst");
      expect(byId.get(id)!.score).toBe(2 * RECO_BURST_WEIGHT);
    }
    expect(byId.get("pair")!.reasons).toEqual(["recent"]);
    expect(byId.get("pair2")!.reasons).toEqual(["recent"]);
    expect(byId.get("late")!.reasons).toEqual(["recent"]);
    // Newest-first among equal burst scores.
    expect(scored.slice(0, 3).map((s) => s.photoId)).toEqual(["b3", "b2", "b1"]);
  });

  it("the 120-second burst window is inclusive", () => {
    const scored = scorePhotoRecommendations([
      signal({ photoId: "at-0", uploadedBy: "member-e", uploadedAt: "2026-10-05T09:00:00.000Z" }),
      signal({ photoId: "at-60", uploadedBy: "member-e", uploadedAt: "2026-10-05T09:01:00.000Z" }),
      signal({ photoId: "at-120", uploadedBy: "member-e", uploadedAt: "2026-10-05T09:02:00.000Z" }),
    ]);
    for (const s of scored) expect(s.reasons).toContain("same_burst");
  });

  it("cold start falls back to newest-first with the recent reason", () => {
    const scored = scorePhotoRecommendations([
      signal({ photoId: "old", uploadedAt: "2026-10-01T00:00:00.000Z" }),
      signal({ photoId: "new", uploadedBy: "member-b", uploadedAt: "2026-10-09T00:00:00.000Z" }),
      signal({ photoId: "mid", uploadedBy: "member-c", uploadedAt: "2026-10-05T00:00:00.000Z" }),
    ]);
    expect(scored.map((s) => s.photoId)).toEqual(["new", "mid", "old"]);
    for (const s of scored) {
      expect(s.score).toBe(0);
      expect(s.reasons).toEqual(["recent"]);
    }
  });

  it("breaks complete ties by photo id ascending, never by locale", () => {
    const at = "2026-10-05T00:00:00.000Z";
    const scored = scorePhotoRecommendations([
      signal({ photoId: "b-photo", uploadedBy: "member-x", uploadedAt: at }),
      signal({ photoId: "a-photo", uploadedBy: "member-y", uploadedAt: at }),
      signal({ photoId: "c-photo", uploadedBy: "member-z", uploadedAt: at }),
    ]);
    expect(scored.map((s) => s.photoId)).toEqual(["a-photo", "b-photo", "c-photo"]);
  });

  it("is order-independent: shuffling the input never changes the output", () => {
    const inputs = [
      signal({ photoId: "p1", pinned: true }),
      signal({ photoId: "p2", views: 7, uploadedBy: "member-b" }),
      signal({ photoId: "p3", uploadedBy: "member-c", uploadedAt: "2026-10-02T10:00:00.000Z" }),
      signal({ photoId: "p4", uploadedBy: "member-c", uploadedAt: "2026-10-02T10:01:00.000Z" }),
      signal({ photoId: "p5", uploadedBy: "member-c", uploadedAt: "2026-10-02T10:02:00.000Z" }),
    ];
    const base = scorePhotoRecommendations(inputs).map((s) => s.photoId);
    for (let i = 0; i < 5; i += 1) {
      const rotated = [...inputs.slice(i), ...inputs.slice(0, i)];
      expect(scorePhotoRecommendations(rotated).map((s) => s.photoId)).toEqual(base);
    }
  });
});

// ---------------------------------------------------------------------------
// Offline evaluation dataset (no database required)
// ---------------------------------------------------------------------------

describe("recommendation evaluation dataset", () => {
  const dataset = parseRecoDataset(
    JSON.parse(readFileSync(new URL("../eval/reco-dataset.json", import.meta.url), "utf8"))
  );

  it("passes every golden ordering and precision threshold", () => {
    const report = evaluateRecoDataset(dataset);
    expect(report.passed).toBe(true);
    expect(report.cases.every((c) => c.goldenMatch)).toBe(true);
    const mixed = report.cases.find((c) => c.id === "mixed-signals")!;
    expect(mixed.precisionAtK).toBeCloseTo(0.833, 3);
    expect(mixed.k).toBe(6);
  });

  it("is deterministic across repeated evaluations", () => {
    const a = evaluateRecoDataset(dataset);
    const b = evaluateRecoDataset(dataset);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// API integration (requires TEST_DATABASE_URL)
// ---------------------------------------------------------------------------

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

const adminA = { Authorization: "Bearer valid.clerk_reco_admin" };
const memberA = { Authorization: "Bearer valid.clerk_reco_member" };
const adminB = { Authorization: "Bearer valid.clerk_reco_admin_b" };

function pngUpload(): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([header, Buffer.alloc(60)]);
}

/** Exact-value presence check (recursive) — substring checks are too loose for short secrets like PINs. */
function containsExactValue(value: unknown, needle: string): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string" || typeof value === "number") return String(value) === needle;
  if (Array.isArray(value)) return value.some((v) => containsExactValue(v, needle));
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((v) =>
      containsExactValue(v, needle)
    );
  }
  return false;
}

describeIf(hasDb)("photo recommendations API", () => {
  let app: ReturnType<typeof createApp>;
  let env: Env;
  let eventId: string;
  let workspaceId: string;
  let photoIds: string[]; // [photo1, photo2, photo3] — photo3 newest after SQL re-stamping
  let eventB: string;
  let photoB: string;

  beforeEach(async () => {
    process.env.DATABASE_URL = dbUrl!;
    process.env.DATABASE_SSL_CA = "";
    app = buildApp();
    const { loadEnv } = await import("../src/config/env.js");
    env = loadEnv();
    await seed(env);
    await wipeAnalytics(env);

    const created = await request(app)
      .post("/api/v1/events")
      .set(adminA)
      .send({ name: `Reco Event ${Date.now()}`, event_date: "2026-12-01" });
    expect(created.status).toBe(201);
    eventId = created.body.event.id;
    const ws = await getPool(env).query<{ workspace_id: string }>(
      "SELECT workspace_id FROM events WHERE id = $1",
      [eventId]
    );
    workspaceId = ws.rows[0]!.workspace_id;

    photoIds = [];
    for (let i = 0; i < 3; i += 1) {
      const up = await request(app)
        .post(`/api/v1/events/${eventId}/photos`)
        .set(adminA)
        .attach("photos", pngUpload(), { filename: `reco-${i}.png`, contentType: "image/png" });
      expect(up.status).toBe(201);
      photoIds.push(up.body.photos[0].id as string);
    }
    // Re-stamp upload times so recency and bursts are deterministic: photo3
    // newest, photo1 one hour older, photo2 three hours older. Same uploader,
    // all > 120s apart -> no accidental burst signal.
    const pool = getPool(env);
    await pool.query("UPDATE photos SET created_at = now() - interval '1 hour' WHERE id = $1", [
      photoIds[0],
    ]);
    await pool.query("UPDATE photos SET created_at = now() - interval '3 hours' WHERE id = $1", [
      photoIds[1],
    ]);

    // Other workspace (isolation probe).
    const other = await request(app)
      .post("/api/v1/events")
      .set(adminB)
      .send({ name: `Reco Other ${Date.now()}`, event_date: "2026-12-02" });
    expect(other.status).toBe(201);
    eventB = other.body.event.id as string;
    const upB = await request(app)
      .post(`/api/v1/events/${eventB}/photos`)
      .set(adminB)
      .attach("photos", pngUpload(), { filename: "reco-b.png", contentType: "image/png" });
    expect(upB.status).toBe(201);
    photoB = upB.body.photos[0].id as string;
  });

  afterAll(async () => {
    const pool = getPool(env);
    await wipeAnalytics(env).catch(() => undefined);
    await pool.query(
      `DELETE FROM photos WHERE uploaded_by IN
       (SELECT id FROM users WHERE clerk_user_id LIKE 'clerk_reco_%')`
    );
    await pool.query("DELETE FROM events WHERE name LIKE 'Reco Event %' OR name LIKE 'Reco Other %'");
    await pool.query(
      `UPDATE workspaces SET created_by = NULL
       WHERE created_by IN (SELECT id FROM users WHERE clerk_user_id LIKE 'clerk_reco_%')`
    );
    await pool.query(
      `DELETE FROM users WHERE clerk_user_id IN
       ('clerk_reco_admin','clerk_reco_member','clerk_reco_admin_b')`
    );
    await pool.query(`DELETE FROM workspaces WHERE name IN ('WS-reco-a','WS-reco-b')`);
    await closePool();
  });

  async function addPhotoView(photoId: string, howMany = 1): Promise<void> {
    for (let i = 0; i < howMany; i += 1) {
      const made = makePhotoViewed({
        galleryId: eventId,
        workspaceId,
        photoId,
        visitorId: "71111111-1111-4111-8111-111111111111",
        correlationId: `corr-${Math.random().toString(36).slice(2)}`,
        trafficSource: { source: "direct", medium: null, campaign: null },
      });
      const stored = await processAnalyticsRecord(env, {
        ...made,
        occurredAt: new Date().toISOString(),
      });
      expect(stored).toBe("stored");
    }
  }

  function getReco(id = eventId, params = "", token: Record<string, string> = adminA) {
    return request(app)
      .get(`/api/v1/events/${id}/photo-recommendations${params}`)
      .set(token);
  }

  function pinPhoto(id: string, photoId: string, token: Record<string, string> = adminA) {
    return request(app)
      .post(`/api/v1/events/${id}/photo-picks`)
      .set(token)
      .send({ photo_id: photoId });
  }

  it("ranks pins, then popular, then cold photos with reasons", async () => {
    await pinPhoto(eventId, photoIds[1]!);
    await addPhotoView(photoIds[0]!, 3);

    const res = await getReco();
    expect(res.status).toBe(200);
    expect(res.body.strategy).toBe("deterministic-baseline-v1");
    expect(res.body.window_days).toBe(30);
    expect(res.body.candidates).toBe(3);

    const recs = res.body.recommendations as Array<{ photo: { id: string }; score: number; reasons: string[] }>;
    expect(recs.map((r) => r.photo.id)).toEqual([photoIds[1], photoIds[0], photoIds[2]]);
    expect(recs[0]).toMatchObject({ score: RECO_PIN_WEIGHT, reasons: ["admin_pick"] });
    expect(recs[1]).toMatchObject({ score: 3, reasons: ["popular"] });
    expect(recs[2]).toMatchObject({ score: 0, reasons: ["recent"] });
    for (const r of recs) {
      expect(Object.keys(r).sort()).toEqual(["photo", "reasons", "score"]);
    }
  });

  it("is deterministic: repeated calls return identical rankings and scores", async () => {
    await pinPhoto(eventId, photoIds[0]!);
    const first = await getReco();
    const second = await getReco();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // Derivative pipeline state is async and volatile between calls; the
    // determinism contract covers the ranking itself (order, scores, reasons).
    const project = (body: typeof first.body) => ({
      strategy: body.strategy,
      window_days: body.window_days,
      candidates: body.candidates,
      recommendations: (
        body.recommendations as Array<{ photo: { id: string }; score: number; reasons: string[] }>
      ).map((r) => ({ id: r.photo.id, score: r.score, reasons: r.reasons })),
    });
    expect(project(second.body)).toEqual(project(first.body));
  });

  it("cold start: no signals ranks newest-first", async () => {
    const res = await getReco();
    expect(res.status).toBe(200);
    const recs = res.body.recommendations as Array<{ photo: { id: string }; reasons: string[] }>;
    expect(recs.map((r) => r.photo.id)).toEqual([photoIds[2], photoIds[0], photoIds[1]]);
    for (const r of recs) expect(r.reasons).toEqual(["recent"]);
  });

  it("an empty event returns zero candidates and no recommendations", async () => {
    const created = await request(app)
      .post("/api/v1/events")
      .set(adminA)
      .send({ name: `Reco Event Empty ${Date.now()}`, event_date: "2026-12-03" });
    expect(created.status).toBe(201);
    const res = await getReco(created.body.event.id as string);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      strategy: "deterministic-baseline-v1",
      window_days: 30,
      candidates: 0,
      recommendations: [],
    });
    await getPool(env).query("DELETE FROM events WHERE id = $1", [created.body.event.id]);
  });

  it("limit caps the list and validates 1-50", async () => {
    const one = await getReco(eventId, "?limit=1");
    expect(one.status).toBe(200);
    expect(one.body.recommendations).toHaveLength(1);
    expect(one.body.candidates).toBe(3);

    for (const bad of ["?limit=0", "?limit=51", "?limit=abc", "?limit="]) {
      expect((await getReco(eventId, bad)).status).toBe(400);
    }
  });

  it("never leaks galleries: draft gallery ids, slugs and PINs stay out of payloads", async () => {
    const gal = await request(app)
      .post(`/api/v1/events/${eventId}/galleries`)
      .set(adminA)
      .send({ name: `Reco Draft ${Date.now()}`, photo_ids: photoIds });
    expect(gal.status).toBe(201);
    const gallery = gal.body.gallery as { id: string; slug: string; pin: string };

    const res = await getReco();
    expect(res.status).toBe(200);
    const payload = JSON.stringify(res.body);
    // Photo objects carry their own derivative "status" fields legitimately,
    // so the assertions are about gallery material only: ids, slugs, PINs.
    expect(payload).not.toContain(gallery.id);
    expect(payload).not.toContain(gallery.slug);
    expect(payload).not.toMatch(/"pin"\s*:/);
    expect(containsExactValue(res.body, gallery.pin)).toBe(false);
  });

  it("rejects unauthenticated and member callers; 404s foreign or unknown events", async () => {
    const noToken = await request(app).get(`/api/v1/events/${eventId}/photo-recommendations`);
    expect(noToken.status).toBe(401);

    const asMember = await getReco(eventId, "", memberA);
    expect(asMember.status).toBe(403);

    const foreign = await getReco(eventB);
    expect(foreign.status).toBe(404);

    const unknown = await getReco("00000000-0000-4000-8000-000000000000");
    expect(unknown.status).toBe(404);
  });

  it("picks are idempotent and workspace/event scoped", async () => {
    const first = await pinPhoto(eventId, photoIds[0]!);
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ photo_id: photoIds[0], picked: true });

    const again = await pinPhoto(eventId, photoIds[0]!);
    expect(again.status).toBe(200);

    const badBody = await pinPhoto(eventId, "not-a-uuid");
    expect(badBody.status).toBe(400);

    // A photo from another workspace's event is a 404, never a pick.
    const cross = await pinPhoto(eventId, photoB);
    expect(cross.status).toBe(404);
    const crossEvent = await pinPhoto(eventB, photoIds[0]!);
    expect(crossEvent.status).toBe(404);

    // Photo not in the event, though in the same workspace (event 2 of A).
    const second = await request(app)
      .post("/api/v1/events")
      .set(adminA)
      .send({ name: `Reco Event Two ${Date.now()}`, event_date: "2026-12-04" });
    const secondId = second.body.event.id as string;
    const up = await request(app)
      .post(`/api/v1/events/${secondId}/photos`)
      .set(adminA)
      .attach("photos", pngUpload(), { filename: "reco-other.png", contentType: "image/png" });
    const otherPhoto = up.body.photos[0].id as string;
    expect((await pinPhoto(eventId, otherPhoto)).status).toBe(404);
    // The pick never landed anywhere.
    const picks = await getPool(env).query("SELECT 1 FROM curation_picks WHERE photo_id = $1", [
      otherPhoto,
    ]);
    expect(picks.rowCount).toBe(0);

    // Unpin: idempotent 204s.
    const unpin = await request(app)
      .delete(`/api/v1/events/${eventId}/photo-picks/${photoIds[0]}`)
      .set(adminA);
    expect(unpin.status).toBe(204);
    const unpinAgain = await request(app)
      .delete(`/api/v1/events/${eventId}/photo-picks/${photoIds[0]}`)
      .set(adminA);
    expect(unpinAgain.status).toBe(204);
    const foreignUnpin = await request(app)
      .delete(`/api/v1/events/${eventId}/photo-picks/${photoB}`)
      .set(adminA);
    expect(foreignUnpin.status).toBe(404);

    // After unpin the photo is no longer a pick.
    const res = await getReco();
    const recs = res.body.recommendations as Array<{ reasons: string[] }>;
    expect(recs.every((r) => !r.reasons.includes("admin_pick"))).toBe(true);
  });

  it("member callers cannot pin, and workspace B picks never affect workspace A", async () => {
    const asMember = await pinPhoto(eventId, photoIds[0]!, memberA);
    expect(asMember.status).toBe(403);

    const pinB = await pinPhoto(eventB, photoB, adminB);
    expect(pinB.status).toBe(201);
    const resB = await getReco(eventB, "", adminB);
    const recsB = resB.body.recommendations as Array<{ photo: { id: string }; reasons: string[] }>;
    expect(recsB[0]!.photo.id).toBe(photoB);
    expect(recsB[0]!.reasons).toEqual(["admin_pick"]);

    const resA = await getReco();
    const recsA = resA.body.recommendations as Array<{ reasons: string[] }>;
    expect(recsA.every((r) => !r.reasons.includes("admin_pick"))).toBe(true);
  });

  async function seed(env: Env) {
    const pool = getPool(env);
    for (const name of ["WS-reco-a", "WS-reco-b"]) {
      await pool.query(
        `INSERT INTO workspaces (name)
         SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM workspaces WHERE name = $1)`,
        [name]
      );
    }
    await pool.query(
      `INSERT INTO users (clerk_user_id, name, email, role, workspace_id) VALUES
         ('clerk_reco_admin', 'Reco Admin', 'reco_admin@frameflow.test', 'ADMIN',
           (SELECT id FROM workspaces WHERE name = 'WS-reco-a')),
         ('clerk_reco_member', 'Reco Member', 'reco_member@frameflow.test', 'TEAM_MEMBER',
           (SELECT id FROM workspaces WHERE name = 'WS-reco-a')),
         ('clerk_reco_admin_b', 'Reco Admin B', 'reco_admin_b@frameflow.test', 'ADMIN',
           (SELECT id FROM workspaces WHERE name = 'WS-reco-b'))
       ON CONFLICT (clerk_user_id) DO NOTHING`
    );
  }

  async function wipeAnalytics(env: Env): Promise<void> {
    await getPool(env).query(
      `DELETE FROM analytics_event_log WHERE workspace_id IN
       (SELECT id FROM workspaces WHERE name IN ('WS-reco-a','WS-reco-b'))`
    );
  }
});

if (!hasDb) {
  console.warn("TEST_DATABASE_URL not set — skipping photo recommendations API tests");
}
