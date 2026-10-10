import { createHash } from "node:crypto";
import type pg from "pg";

import type { AnalyticsEvent } from "./analytics-events.js";

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
