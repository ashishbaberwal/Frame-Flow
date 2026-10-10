import type { Env } from "../config/env.js";
import { validateAnalyticsEvent, type AnalyticsEvent } from "./analytics-events.js";
import { getPool } from "./db.js";

// ---------------------------------------------------------------------------
// Analytics sink: the consumer persists every validated event here BEFORE
// committing its Kafka offset. event_id is producer-minted with a primary-
// key guard, so at-least-once redelivery collapses into the existing row
// instead of double-counting. Invalid payloads are counted and skipped —
// a poison message must never wedge the consumer (it is still resolved so
// the offset advances past it).
// ---------------------------------------------------------------------------

export type AnalyticsStoreOutcome = "stored" | "duplicate" | "invalid";

function log(event: string, detail: string): void {
  console.log(JSON.stringify({ scope: "analytics-sink", event, detail }));
}

/** Validate + insert one raw payload. Idempotent by event_id. */
export async function processAnalyticsRecord(
  env: Env,
  raw: unknown
): Promise<AnalyticsStoreOutcome> {
  const checked = validateAnalyticsEvent(raw);
  if (!checked.ok) {
    log("skipped-invalid", checked.error);
    return "invalid";
  }
  return storeAnalyticsEvent(env, checked.event);
}

/** Insert a validated event. ON CONFLICT DO NOTHING is the dedupe point. */
export async function storeAnalyticsEvent(
  env: Env,
  event: AnalyticsEvent
): Promise<"stored" | "duplicate"> {
  const photoId =
    event.eventType === "PhotoViewed" || event.eventType === "PhotoDownloaded"
      ? event.photoId
      : null;
  const photoCount =
    event.eventType === "GalleryViewed" || event.eventType === "GalleryDownloaded"
      ? event.photoCount
      : null;
  const channel = event.eventType === "GalleryShared" ? event.channel : null;
  const result = await getPool(env).query(
    `INSERT INTO analytics_event_log
       (event_id, event_type, schema_version, occurred_at, gallery_id,
        workspace_id, visitor_id, correlation_id, traffic_source,
        traffic_medium, traffic_campaign, photo_id, photo_count, channel, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
     ON CONFLICT (event_id) DO NOTHING`,
    [
      event.eventId,
      event.eventType,
      event.schemaVersion,
      event.occurredAt,
      event.galleryId,
      event.workspaceId,
      event.visitorId,
      event.correlationId,
      event.trafficSource.source,
      event.trafficSource.medium,
      event.trafficSource.campaign,
      photoId,
      photoCount,
      channel,
      JSON.stringify(event),
    ]
  );
  return (result.rowCount ?? 0) > 0 ? "stored" : "duplicate";
}
