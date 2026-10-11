import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { resetEnvCache } from "../src/config/env.js";
import { closePool, getPool } from "../src/lib/db.js";
import { makeGalleryShared, makePhotoDownloaded, makePhotoViewed } from "../src/lib/analytics-events.js";
import { processAnalyticsRecord } from "../src/lib/analytics-sink.js";
import type { Env } from "../src/config/env.js";

/**
 * Phase 6 aggregation: photo view/download classification, gallery
 * engagement counters, share counting, and redelivery safety through the
 * real consumer path (processAnalyticsRecord).
 */

const GALLERY_ID = "81111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "82222222-2222-4222-8222-222222222222";
const PHOTO_A = "83333333-3333-4333-8333-333333333333";
const PHOTO_B = "84444444-4444-4444-8444-444444444444";
const VISITOR = "85555555-5555-4555-8555-555555555555";

const dbUrl = process.env.TEST_DATABASE_URL;
const hasDb = !!dbUrl;
const describeIf = (cond: boolean) => (cond ? describe : describe.skip);

function base() {
  return {
    galleryId: GALLERY_ID,
    workspaceId: WORKSPACE_ID,
    visitorId: VISITOR,
    correlationId: "corr-eng-1",
    trafficSource: { source: "direct" as const, medium: null, campaign: null },
  };
}

describeIf(hasDb)("Analytics engagement aggregation", () => {
  let env: Env;

  beforeEach(async () => {
    process.env.DATABASE_URL = dbUrl!;
    process.env.DATABASE_SSL_CA = "";
    process.env.NODE_ENV = "test";
    resetEnvCache();
    const { loadEnv } = await import("../src/config/env.js");
    env = loadEnv();
    const pool = getPool(env);
    for (const table of [
      "photo_daily_stats",
      "gallery_traffic_visitors",
      "gallery_traffic_sources",
      "gallery_visitor_days",
      "gallery_daily_stats",
      "analytics_event_log",
    ]) {
      await pool.query(`DELETE FROM ${table} WHERE gallery_id = $1`, [GALLERY_ID]);
    }
  });

  afterAll(async () => {
    await closePool();
  });

  async function photoStats() {
    const r = await getPool(env).query<{
      photo_id: string;
      views: number;
      downloads: number;
    }>("SELECT photo_id::text AS photo_id, views, downloads FROM photo_daily_stats WHERE gallery_id = $1 ORDER BY photo_id",
      [GALLERY_ID]
    );
    return r.rows;
  }

  async function galleryEngagement() {
    const r = await getPool(env).query<{
      views: number;
      photo_views: number;
      photo_downloads: number;
      shares: number;
    }>(
      "SELECT views, photo_views, photo_downloads, shares FROM gallery_daily_stats WHERE gallery_id = $1",
      [GALLERY_ID]
    );
    return r.rows[0] ?? { views: 0, photo_views: 0, photo_downloads: 0, shares: 0 };
  }

  it("classifies views and downloads per photo and gallery", async () => {
    expect(await processAnalyticsRecord(env, makePhotoViewed({ ...base(), photoId: PHOTO_A }))).toBe(
      "stored"
    );
    expect(await processAnalyticsRecord(env, makePhotoViewed({ ...base(), photoId: PHOTO_A }))).toBe(
      "stored"
    );
    expect(
      await processAnalyticsRecord(env, makePhotoDownloaded({ ...base(), photoId: PHOTO_A }))
    ).toBe("stored");
    expect(await processAnalyticsRecord(env, makePhotoViewed({ ...base(), photoId: PHOTO_B }))).toBe(
      "stored"
    );

    expect(await photoStats()).toEqual([
      { photo_id: PHOTO_A, views: 2, downloads: 1 },
      { photo_id: PHOTO_B, views: 1, downloads: 0 },
    ]);
    // No GalleryViewed was stored: the gallery row exists purely from
    // engagement upserts, with zero views of its own.
    expect(await galleryEngagement()).toMatchObject({
      views: 0,
      photo_views: 3,
      photo_downloads: 1,
      shares: 0,
    });
  });

  it("redelivery never recounts engagement", async () => {
    const event = makePhotoDownloaded({ ...base(), photoId: PHOTO_A });
    expect(await processAnalyticsRecord(env, event)).toBe("stored");
    expect(await processAnalyticsRecord(env, event)).toBe("duplicate");
    expect(await photoStats()).toEqual([{ photo_id: PHOTO_A, views: 0, downloads: 1 }]);
  });

  it("concurrent redelivery counts once", async () => {
    const event = makePhotoViewed({ ...base(), photoId: PHOTO_A });
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => processAnalyticsRecord(env, event))
    );
    expect(outcomes.filter((o) => o === "stored").length).toBe(1);
    expect(await photoStats()).toEqual([{ photo_id: PHOTO_A, views: 1, downloads: 0 }]);
  });

  it("counts share clicks per gallery", async () => {
    expect(
      await processAnalyticsRecord(env, makeGalleryShared({ ...base(), channel: "clipboard" }))
    ).toBe("stored");
    expect(
      await processAnalyticsRecord(env, makeGalleryShared({ ...base(), channel: "native" }))
    ).toBe("stored");
    expect(await galleryEngagement()).toMatchObject({ shares: 2, views: 0 });
  });
});

if (!hasDb) {
  console.warn("TEST_DATABASE_URL not set — skipping engagement aggregation tests");
}
