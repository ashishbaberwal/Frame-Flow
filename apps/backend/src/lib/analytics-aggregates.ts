import { createHash } from "node:crypto";
import type pg from "pg";

import type { Env } from "../config/env.js";
import type { AnalyticsEvent } from "./analytics-events.js";
import { getPool } from "./db.js";

// ---------------------------------------------------------------------------
// Gallery analytics aggregation (Phase 5, write side).
//
// aggregateGalleryViewed folds ONE newly stored GalleryViewed into the
// rollup tables. The caller runs it in the same transaction AFTER the raw
// log insert succeeded for a new event_id — every counter here increments
// only on a real insert (rowCount-gated), so redelivery and concurrent
// duplicates can never inflate a total. Counters only move forward; there
// is no decrement path (gallery deletion keeps history — see migration).
// ---------------------------------------------------------------------------

/** SHA-256 hex of the pseudonymous visitor id — the stored unit of uniques. */
export function hashVisitorId(visitorId: string): string {
  return createHash("sha256").update(visitorId).digest("hex");
}

/** UTC calendar day (YYYY-MM-DD) of an event timestamp, server-TZ-proof. */
export function utcDay(occurredAt: string): string {
  return new Date(occurredAt).toISOString().slice(0, 10);
}

export type GalleryViewedEvent = Extract<AnalyticsEvent, { eventType: "GalleryViewed" }>;

export async function aggregateGalleryViewed(
  client: pg.PoolClient,
  event: GalleryViewedEvent
): Promise<void> {
  const day = utcDay(event.occurredAt);

  await client.query(
    `INSERT INTO gallery_daily_stats (gallery_id, workspace_id, day, views, unique_visitors)
     VALUES ($1, $2, $3::date, 1, 0)
     ON CONFLICT (gallery_id, day) DO UPDATE
     SET views = gallery_daily_stats.views + 1`,
    [event.galleryId, event.workspaceId, day]
  );

  if (event.visitorId) {
    const hash = hashVisitorId(event.visitorId);
    const visitorRow = await client.query(
      `INSERT INTO gallery_visitor_days (gallery_id, workspace_id, day, visitor_hash)
       VALUES ($1, $2, $3::date, $4)
       ON CONFLICT DO NOTHING`,
      [event.galleryId, event.workspaceId, day, hash]
    );
    if ((visitorRow.rowCount ?? 0) > 0) {
      await client.query(
        `UPDATE gallery_daily_stats
         SET unique_visitors = unique_visitors + 1
         WHERE gallery_id = $1 AND day = $2::date`,
        [event.galleryId, day]
      );
    }
  }

  await client.query(
    `INSERT INTO gallery_traffic_sources
       (gallery_id, workspace_id, day, source, views, unique_visitors)
     VALUES ($1, $2, $3::date, $4, 1, 0)
     ON CONFLICT (gallery_id, day, source) DO UPDATE
     SET views = gallery_traffic_sources.views + 1`,
    [event.galleryId, event.workspaceId, day, event.trafficSource.source]
  );

  if (event.visitorId) {
    const hash = hashVisitorId(event.visitorId);
    const sourceVisitor = await client.query(
      `INSERT INTO gallery_traffic_visitors
         (gallery_id, workspace_id, day, source, visitor_hash)
       VALUES ($1, $2, $3::date, $4, $5)
       ON CONFLICT DO NOTHING`,
      [event.galleryId, event.workspaceId, day, event.trafficSource.source, hash]
    );
    if ((sourceVisitor.rowCount ?? 0) > 0) {
      await client.query(
        `UPDATE gallery_traffic_sources
         SET unique_visitors = unique_visitors + 1
         WHERE gallery_id = $1 AND day = $2::date AND source = $3`,
        [event.galleryId, day, event.trafficSource.source]
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Reads (admin dashboard). Range uniques are exact COUNT DISTINCT over the
// visitor-set tables — never the sum of daily uniques (a visitor on two days
// counts once for the range). Every query is workspace-scoped; gallery reads
// additionally pin gallery_id, so no workspace can see another's numbers.
// ---------------------------------------------------------------------------

export type AnalyticsRange = { from: string; to: string };

export type DayBucket = { day: string; views: number; unique_visitors: number };
export type SourceBucket = { source: string; views: number; unique_visitors: number };

export type GalleryAnalytics = {
  totals: { views: number; unique_visitors: number };
  by_day: DayBucket[];
  sources: SourceBucket[];
};

export type WorkspaceAnalytics = {
  totals: { views: number; unique_visitors: number; galleries: number };
  galleries: { id: string; name: string | null; slug: string | null; views: number; unique_visitors: number }[];
  sources: SourceBucket[];
};

/** Zero-filled daily series for one gallery over [from, to] (inclusive). */
export async function getGalleryAnalytics(
  env: Env,
  galleryId: string,
  range: AnalyticsRange
): Promise<GalleryAnalytics> {
  const pool = getPool(env);
  const totals = await pool.query<{ views: number; unique_visitors: number }>(
    `SELECT COALESCE(SUM(s.views), 0)::int AS views,
            (SELECT COUNT(DISTINCT v.visitor_hash)::int FROM gallery_visitor_days v
             WHERE v.gallery_id = $1 AND v.day BETWEEN $2::date AND $3::date) AS unique_visitors
     FROM gallery_daily_stats s
     WHERE s.gallery_id = $1 AND s.day BETWEEN $2::date AND $3::date`,
    [galleryId, range.from, range.to]
  );
  const byDay = await pool.query<DayBucket>(
    `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
            COALESCE(s.views, 0)::int AS views,
            COALESCE(s.unique_visitors, 0)::int AS unique_visitors
     FROM generate_series($2::date, $3::date, interval '1 day') AS d(day)
     LEFT JOIN gallery_daily_stats s ON s.gallery_id = $1 AND s.day = d.day
     ORDER BY d.day`,
    [galleryId, range.from, range.to]
  );
  const sourceViews = await pool.query<{ source: string; views: number }>(
    `SELECT source, SUM(views)::int AS views
     FROM gallery_traffic_sources
     WHERE gallery_id = $1 AND day BETWEEN $2::date AND $3::date
     GROUP BY source`,
    [galleryId, range.from, range.to]
  );
  const sourceUniques = await pool.query<{ source: string; unique_visitors: number }>(
    `SELECT source, COUNT(DISTINCT visitor_hash)::int AS unique_visitors
     FROM gallery_traffic_visitors
     WHERE gallery_id = $1 AND day BETWEEN $2::date AND $3::date
     GROUP BY source`,
    [galleryId, range.from, range.to]
  );
  const uniquesBySource = new Map(sourceUniques.rows.map((r) => [r.source, r.unique_visitors]));
  const sources: SourceBucket[] = sourceViews.rows
    .map((r) => ({
      source: r.source,
      views: r.views,
      unique_visitors: uniquesBySource.get(r.source) ?? 0,
    }))
    .sort((a, b) => b.views - a.views || a.source.localeCompare(b.source));
  return {
    totals: totals.rows[0] ?? { views: 0, unique_visitors: 0 },
    by_day: byDay.rows,
    sources,
  };
}

/** Workspace overview: totals, per-gallery breakdown, top sources. */
export async function getWorkspaceAnalytics(
  env: Env,
  workspaceId: string,
  range: AnalyticsRange
): Promise<WorkspaceAnalytics> {
  const pool = getPool(env);
  const totals = await pool.query<{ views: number; unique_visitors: number; galleries: number }>(
    `SELECT COALESCE(SUM(s.views), 0)::int AS views,
            (SELECT COUNT(DISTINCT v.visitor_hash)::int FROM gallery_visitor_days v
             WHERE v.workspace_id = $1 AND v.day BETWEEN $2::date AND $3::date) AS unique_visitors,
            (SELECT COUNT(DISTINCT s2.gallery_id)::int FROM gallery_daily_stats s2
             WHERE s2.workspace_id = $1 AND s2.day BETWEEN $2::date AND $3::date) AS galleries
     FROM gallery_daily_stats s
     WHERE s.workspace_id = $1 AND s.day BETWEEN $2::date AND $3::date`,
    [workspaceId, range.from, range.to]
  );
  const galleries = await pool.query<{
    id: string;
    views: number;
    unique_visitors: number;
  }>(
    `SELECT s.gallery_id AS id,
            SUM(s.views)::int AS views,
            (SELECT COUNT(DISTINCT v.visitor_hash)::int FROM gallery_visitor_days v
             WHERE v.gallery_id = s.gallery_id AND v.day BETWEEN $2::date AND $3::date) AS unique_visitors
     FROM gallery_daily_stats s
     WHERE s.workspace_id = $1 AND s.day BETWEEN $2::date AND $3::date
     GROUP BY s.gallery_id
     ORDER BY views DESC, id ASC`,
    [workspaceId, range.from, range.to]
  );
  // Names/slugs are display-only and best-effort (deleted galleries keep
  // history but lose metadata) — one lookup, never a join that drops rows.
  const meta =
    galleries.rows.length > 0
      ? await pool.query<{ id: string; name: string; slug: string }>(
          "SELECT id::text AS id, name, slug FROM galleries WHERE id = ANY($1::uuid[])",
          [galleries.rows.map((g) => g.id)]
        )
      : { rows: [] as { id: string; name: string; slug: string }[] };
  const metaById = new Map(meta.rows.map((m) => [m.id, m]));
  const sourceViews = await pool.query<{ source: string; views: number }>(
    `SELECT source, SUM(views)::int AS views
     FROM gallery_traffic_sources
     WHERE workspace_id = $1 AND day BETWEEN $2::date AND $3::date
     GROUP BY source`,
    [workspaceId, range.from, range.to]
  );
  const sourceUniques = await pool.query<{ source: string; unique_visitors: number }>(
    `SELECT source, COUNT(DISTINCT visitor_hash)::int AS unique_visitors
     FROM gallery_traffic_visitors
     WHERE workspace_id = $1 AND day BETWEEN $2::date AND $3::date
     GROUP BY source`,
    [workspaceId, range.from, range.to]
  );
  const uniquesBySource = new Map(sourceUniques.rows.map((r) => [r.source, r.unique_visitors]));
  return {
    totals: totals.rows[0] ?? { views: 0, unique_visitors: 0, galleries: 0 },
    galleries: galleries.rows.map((g) => ({
      id: g.id,
      name: metaById.get(g.id)?.name ?? null,
      slug: metaById.get(g.id)?.slug ?? null,
      views: g.views,
      unique_visitors: g.unique_visitors,
    })),
    sources: sourceViews.rows
      .map((r) => ({
        source: r.source,
        views: r.views,
        unique_visitors: uniquesBySource.get(r.source) ?? 0,
      }))
      .sort((a, b) => b.views - a.views || a.source.localeCompare(b.source)),
  };
}
