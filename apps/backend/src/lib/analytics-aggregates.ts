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

export type PhotoEngagementEvent = Extract<
  AnalyticsEvent,
  { eventType: "PhotoViewed" | "PhotoDownloaded" }
>;

export type GallerySharedEvent = Extract<AnalyticsEvent, { eventType: "GalleryShared" }>;

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

/**
 * Fold ONE newly stored photo view/download into per-photo counts plus the
 * gallery's engagement counters. The gallery row is upserted (not assumed):
 * same-key Kafka ordering normally lands the GalleryViewed first, but the
 * aggregate must not depend on it. Column names come from a fixed ternary —
 * never user input.
 */
export async function aggregatePhotoEngagement(
  client: pg.PoolClient,
  event: PhotoEngagementEvent
): Promise<void> {
  const day = utcDay(event.occurredAt);
  const photoColumn = event.eventType === "PhotoViewed" ? "views" : "downloads";
  const galleryColumn = event.eventType === "PhotoViewed" ? "photo_views" : "photo_downloads";
  const galleryInsert = galleryColumn === "photo_views" ? "1, 0" : "0, 1";
  await client.query(
    `INSERT INTO photo_daily_stats (photo_id, gallery_id, workspace_id, day, views, downloads)
     VALUES ($1, $2, $3, $4::date, ${photoColumn === "views" ? "1, 0" : "0, 1"})
     ON CONFLICT (photo_id, day) DO UPDATE
     SET ${photoColumn} = photo_daily_stats.${photoColumn} + 1`,
    [event.photoId, event.galleryId, event.workspaceId, day]
  );
  await client.query(
    `INSERT INTO gallery_daily_stats (gallery_id, workspace_id, day, views, unique_visitors, photo_views, photo_downloads, shares)
     VALUES ($1, $2, $3::date, 0, 0, ${galleryInsert}, 0)
     ON CONFLICT (gallery_id, day) DO UPDATE
     SET ${galleryColumn} = gallery_daily_stats.${galleryColumn} + 1`,
    [event.galleryId, event.workspaceId, day]
  );
}

/** Fold ONE newly stored share click into the gallery's share counter. */
export async function aggregateGalleryShared(
  client: pg.PoolClient,
  event: GallerySharedEvent
): Promise<void> {
  const day = utcDay(event.occurredAt);
  await client.query(
    `INSERT INTO gallery_daily_stats (gallery_id, workspace_id, day, views, unique_visitors, photo_views, photo_downloads, shares)
     VALUES ($1, $2, $3::date, 0, 0, 0, 0, 1)
     ON CONFLICT (gallery_id, day) DO UPDATE
     SET shares = gallery_daily_stats.shares + 1`,
    [event.galleryId, event.workspaceId, day]
  );
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
  engagement: EngagementSummary;
  top_photos: TopPhoto[];
};

export type EngagementSummary = {
  photo_views: number;
  photo_downloads: number;
  shares: number;
  /**
   * DISTINCT download sessions / DISTINCT sessions over the window, or null
   * when there are no sessions yet. A session is one unlock correlation id —
   * every session renders the gallery, so every session is eligible. This is
   * a download rate with a stated denominator, not a "CTR".
   */
  download_rate: number | null;
};

export type TopPhoto = {
  id: string;
  /** Null once the photo row is deleted; counts survive in the rollup. */
  filename: string | null;
  views: number;
  downloads: number;
};

export type WorkspaceAnalytics = {
  totals: {
    views: number;
    unique_visitors: number;
    galleries: number;
    photo_views: number;
    photo_downloads: number;
    shares: number;
    download_rate: number | null;
  };
  galleries: {
    id: string;
    name: string | null;
    slug: string | null;
    views: number;
    unique_visitors: number;
    photo_views: number;
    photo_downloads: number;
    shares: number;
    download_rate: number | null;
  }[];
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
    engagement: await getGalleryEngagement(env, galleryId, range),
    top_photos: await getTopPhotos(env, galleryId, range),
  };
}

/**
 * Engagement summary + top photos for one gallery. The rate comes from the
 * raw log's correlation sessions (exact distinct counts over the window);
 * counters come from the rollups. Bounds are explicit UTC instants so the
 * server time zone can never shift the window.
 */
export async function getGalleryEngagement(
  env: Env,
  galleryId: string,
  range: AnalyticsRange
): Promise<EngagementSummary> {
  const pool = getPool(env);
  const counters = await pool.query<{
    photo_views: number;
    photo_downloads: number;
    shares: number;
  }>(
    `SELECT COALESCE(SUM(photo_views), 0)::int AS photo_views,
            COALESCE(SUM(photo_downloads), 0)::int AS photo_downloads,
            COALESCE(SUM(shares), 0)::int AS shares
     FROM gallery_daily_stats
     WHERE gallery_id = $1 AND day BETWEEN $2::date AND $3::date`,
    [galleryId, range.from, range.to]
  );
  const sessions = await pool.query<{ sessions: number; with_download: number }>(
    `SELECT COUNT(DISTINCT correlation_id)::int AS sessions,
            COUNT(DISTINCT CASE WHEN event_type = 'PhotoDownloaded'
              THEN correlation_id END)::int AS with_download
     FROM analytics_event_log
     WHERE gallery_id = $1
       AND occurred_at >= ($2 || 'T00:00:00Z')::timestamptz
       AND occurred_at < (($3 || 'T00:00:00Z')::timestamptz + interval '1 day')`,
    [galleryId, range.from, range.to]
  );
  const { sessions: total, with_download: converted } = sessions.rows[0] ?? {
    sessions: 0,
    with_download: 0,
  };
  return {
    photo_views: counters.rows[0]?.photo_views ?? 0,
    photo_downloads: counters.rows[0]?.photo_downloads ?? 0,
    shares: counters.rows[0]?.shares ?? 0,
    download_rate: total > 0 ? converted / total : null,
  };
}

/** Top 10 photos by views over the window (filenames best-effort). */
export async function getTopPhotos(
  env: Env,
  galleryId: string,
  range: AnalyticsRange
): Promise<TopPhoto[]> {
  const rows = await getPool(env).query<TopPhoto>(
    `SELECT p.photo_id::text AS id,
            MAX(ph.filename) AS filename,
            SUM(p.views)::int AS views,
            SUM(p.downloads)::int AS downloads
     FROM photo_daily_stats p
     LEFT JOIN photos ph ON ph.id = p.photo_id
     WHERE p.gallery_id = $1 AND p.day BETWEEN $2::date AND $3::date
     GROUP BY p.photo_id
     ORDER BY views DESC, downloads DESC, id ASC
     LIMIT 10`,
    [galleryId, range.from, range.to]
  );
  return rows.rows;
}

/** Workspace overview: totals, per-gallery breakdown, top sources. */
export async function getWorkspaceAnalytics(
  env: Env,
  workspaceId: string,
  range: AnalyticsRange
): Promise<WorkspaceAnalytics> {
  const pool = getPool(env);
  const totals = await pool.query<{
    views: number;
    unique_visitors: number;
    galleries: number;
    photo_views: number;
    photo_downloads: number;
    shares: number;
  }>(
    `SELECT COALESCE(SUM(s.views), 0)::int AS views,
            (SELECT COUNT(DISTINCT v.visitor_hash)::int FROM gallery_visitor_days v
             WHERE v.workspace_id = $1 AND v.day BETWEEN $2::date AND $3::date) AS unique_visitors,
            (SELECT COUNT(DISTINCT s2.gallery_id)::int FROM gallery_daily_stats s2
             WHERE s2.workspace_id = $1 AND s2.day BETWEEN $2::date AND $3::date) AS galleries,
            COALESCE(SUM(s.photo_views), 0)::int AS photo_views,
            COALESCE(SUM(s.photo_downloads), 0)::int AS photo_downloads,
            COALESCE(SUM(s.shares), 0)::int AS shares
     FROM gallery_daily_stats s
     WHERE s.workspace_id = $1 AND s.day BETWEEN $2::date AND $3::date`,
    [workspaceId, range.from, range.to]
  );
  const galleries = await pool.query<{
    id: string;
    views: number;
    unique_visitors: number;
    photo_views: number;
    photo_downloads: number;
    shares: number;
  }>(
    `SELECT s.gallery_id AS id,
            SUM(s.views)::int AS views,
            (SELECT COUNT(DISTINCT v.visitor_hash)::int FROM gallery_visitor_days v
             WHERE v.gallery_id = s.gallery_id AND v.day BETWEEN $2::date AND $3::date) AS unique_visitors,
            SUM(s.photo_views)::int AS photo_views,
            SUM(s.photo_downloads)::int AS photo_downloads,
            SUM(s.shares)::int AS shares
     FROM gallery_daily_stats s
     WHERE s.workspace_id = $1 AND s.day BETWEEN $2::date AND $3::date
     GROUP BY s.gallery_id
     ORDER BY views DESC, id ASC`,
    [workspaceId, range.from, range.to]
  );
  // Session rates per gallery plus the workspace rollup, each from one
  // grouped raw-log query — never per-gallery fan-out.
  const sessionRates = await pool.query<{ gallery_id: string; sessions: number; with_download: number }>(
    `SELECT gallery_id::text AS gallery_id,
            COUNT(DISTINCT correlation_id)::int AS sessions,
            COUNT(DISTINCT CASE WHEN event_type = 'PhotoDownloaded'
              THEN correlation_id END)::int AS with_download
     FROM analytics_event_log
     WHERE workspace_id = $1
       AND occurred_at >= ($2 || 'T00:00:00Z')::timestamptz
       AND occurred_at < (($3 || 'T00:00:00Z')::timestamptz + interval '1 day')
     GROUP BY gallery_id`,
    [workspaceId, range.from, range.to]
  );
  const rateByGallery = new Map(
    sessionRates.rows.map((r) => [
      r.gallery_id,
      r.sessions > 0 ? r.with_download / r.sessions : null,
    ])
  );
  const rate = (sessions: number, withDownload: number): number | null =>
    sessions > 0 ? withDownload / sessions : null;
  const totalsRow = totals.rows[0] ?? {
    views: 0,
    unique_visitors: 0,
    galleries: 0,
    photo_views: 0,
    photo_downloads: 0,
    shares: 0,
  };
  const wsSessions = sessionRates.rows.reduce((acc, r) => acc + r.sessions, 0);
  const wsConverted = sessionRates.rows.reduce((acc, r) => acc + r.with_download, 0);
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
    totals: { ...totalsRow, download_rate: rate(wsSessions, wsConverted) },
    galleries: galleries.rows.map((g) => ({
      id: g.id,
      name: metaById.get(g.id)?.name ?? null,
      slug: metaById.get(g.id)?.slug ?? null,
      views: g.views,
      unique_visitors: g.unique_visitors,
      photo_views: g.photo_views,
      photo_downloads: g.photo_downloads,
      shares: g.shares,
      download_rate: rateByGallery.get(g.id) ?? null,
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
