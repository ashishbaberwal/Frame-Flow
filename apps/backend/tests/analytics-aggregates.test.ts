import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { resetEnvCache } from "../src/config/env.js";
import { closePool, getPool } from "../src/lib/db.js";
import {
  aggregateGalleryViewed,
  hashVisitorId,
  utcDay,
  type GalleryViewedEvent,
} from "../src/lib/analytics-aggregates.js";
import { makeGalleryViewed } from "../src/lib/analytics-events.js";
import type { Env } from "../src/config/env.js";

/**
 * Phase 5 aggregator unit tests: one GalleryViewed folds into daily stats,
 * visitor-day sets, and per-source rollups exactly once per new event.
 * Duplicate-event gating lives in the sink (commit B); here concurrent
 * DISTINCT events must each count once.
 */

const GALLERY_ID = "71111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "72222222-2222-4222-8222-222222222222";
const VISITOR_A = "74444444-4444-4444-8444-444444444444";
const VISITOR_B = "75555555-5555-4555-8555-555555555555";

const dbUrl = process.env.TEST_DATABASE_URL;
const hasDb = !!dbUrl;
const describeIf = (cond: boolean) => (cond ? describe : describe.skip);

function view(overrides: Partial<GalleryViewedEvent> = {}): GalleryViewedEvent {
  return {
    ...makeGalleryViewed({
      galleryId: GALLERY_ID,
      workspaceId: WORKSPACE_ID,
      visitorId: VISITOR_A,
      correlationId: "corr-agg-1",
      trafficSource: { source: "direct", medium: null, campaign: null },
      photoCount: 4,
    }),
    ...overrides,
  };
}

describeIf(hasDb)("Analytics aggregator", () => {
  let env: Env;

  beforeEach(async () => {
    process.env.DATABASE_URL = dbUrl!;
    process.env.DATABASE_SSL_CA = "";
    process.env.NODE_ENV = "test";
    process.env.CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY ?? "sk_test_placeholder";
    process.env.APPWRITE_ENDPOINT =
      process.env.APPWRITE_ENDPOINT ?? "https://cloud.appwrite.io/v1";
    process.env.APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID ?? "test-project";
    process.env.APPWRITE_API_KEY = process.env.APPWRITE_API_KEY ?? "test-key";
    process.env.APPWRITE_BUCKET_ID = process.env.APPWRITE_BUCKET_ID ?? "test-bucket";
    resetEnvCache();
    const { loadEnv } = await import("../src/config/env.js");
    env = loadEnv();
    const pool = getPool(env);
    await pool.query("DELETE FROM gallery_traffic_visitors WHERE gallery_id = $1", [GALLERY_ID]);
    await pool.query("DELETE FROM gallery_traffic_sources WHERE gallery_id = $1", [GALLERY_ID]);
    await pool.query("DELETE FROM gallery_visitor_days WHERE gallery_id = $1", [GALLERY_ID]);
    await pool.query("DELETE FROM gallery_daily_stats WHERE gallery_id = $1", [GALLERY_ID]);
  });

  afterAll(async () => {
    await closePool();
  });

  async function aggregate(event: GalleryViewedEvent): Promise<void> {
    const client = await getPool(env).connect();
    try {
      await client.query("BEGIN");
      await aggregateGalleryViewed(client, event);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async function stats() {
    const r = await getPool(env).query<{
      day: string;
      views: number;
      unique_visitors: number;
    }>("SELECT day::text AS day, views, unique_visitors FROM gallery_daily_stats WHERE gallery_id = $1 ORDER BY day",
      [GALLERY_ID]
    );
    return r.rows;
  }

  async function sources() {
    const r = await getPool(env).query<{
      day: string;
      source: string;
      views: number;
      unique_visitors: number;
    }>(
      "SELECT day::text AS day, source, views, unique_visitors FROM gallery_traffic_sources WHERE gallery_id = $1 ORDER BY day, source",
      [GALLERY_ID]
    );
    return r.rows;
  }

  it("hashes visitor ids and buckets UTC days", () => {
    expect(hashVisitorId(VISITOR_A)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashVisitorId(VISITOR_A)).not.toContain(VISITOR_A.slice(0, 8));
    expect(utcDay("2026-01-01T23:30:00.000Z")).toBe("2026-01-01");
    expect(utcDay("2026-01-02T00:30:00.000Z")).toBe("2026-01-02");
  });

  it("counts a first view with visitor and source", async () => {
    await aggregate(view());
    expect(await stats()).toEqual([{ day: utcDay(new Date().toISOString()), views: 1, unique_visitors: 1 }]);
    expect(await sources()).toEqual([
      { day: utcDay(new Date().toISOString()), source: "direct", views: 1, unique_visitors: 1 },
    ]);
  });

  it("same visitor twice: views rise, uniques do not", async () => {
    await aggregate(view());
    await aggregate(view());
    expect(await stats()).toMatchObject([{ views: 2, unique_visitors: 1 }]);
  });

  it("missing visitor counts as a view but never a unique", async () => {
    await aggregate(view({ visitorId: null }));
    expect(await stats()).toMatchObject([{ views: 1, unique_visitors: 0 }]);
    expect(await sources()).toMatchObject([{ views: 1, unique_visitors: 0 }]);
  });

  it("tracks unknown and identified sources separately", async () => {
    await aggregate(view());
    await aggregate(
      view({
        visitorId: VISITOR_B,
        trafficSource: { source: "unknown", medium: null, campaign: null },
      })
    );
    await aggregate(
      view({
        visitorId: VISITOR_B,
        trafficSource: { source: "google.com", medium: "organic", campaign: null },
      })
    );
    const rows = await sources();
    expect(rows.map((r) => [r.source, r.views, r.unique_visitors])).toEqual([
      ["direct", 1, 1],
      ["google.com", 1, 1],
      ["unknown", 1, 1],
    ]);
    expect(await stats()).toMatchObject([{ views: 3, unique_visitors: 2 }]);
  });

  it("buckets either side of the UTC midnight boundary", async () => {
    await aggregate(view({ occurredAt: "2026-03-01T23:30:00.000Z" }));
    await aggregate(view({ occurredAt: "2026-03-02T00:30:00.000Z" }));
    expect(await stats()).toEqual([
      { day: "2026-03-01", views: 1, unique_visitors: 1 },
      { day: "2026-03-02", views: 1, unique_visitors: 1 },
    ]);
  });

  it("concurrent distinct events each count exactly once", async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        aggregate(view({ correlationId: `corr-burst-${i}` }))
      )
    );
    expect(await stats()).toMatchObject([{ views: 10, unique_visitors: 1 }]);
  });
});

if (!hasDb) {
  console.warn("TEST_DATABASE_URL not set — skipping analytics aggregator tests");
}
