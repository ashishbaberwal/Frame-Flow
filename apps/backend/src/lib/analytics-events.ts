import { randomUUID } from "node:crypto";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Analytics event contracts (Phase 4), schema version 1.
//
// Every analytics/engagement event the API emits validates against these
// schemas BEFORE it is published, and the consumer re-validates on receipt.
// Versioning rule: additive optional fields may arrive in v1; any breaking
// change (rename, remove, type change) requires schemaVersion 2 plus a
// consumer that still accepts v1 during the migration window.
//
// Privacy: events carry ids, timestamps, and a normalized traffic source
// only. They MUST never contain PINs, auth tokens, storage credentials,
// emails, IPs, or full URLs (query strings can leak tokens).
// ---------------------------------------------------------------------------

/** Current contract version — bump only with a consumer migration plan. */
export const EVENT_SCHEMA_VERSION = 1 as const;

/** Default Kafka topic (overridable via KAFKA_TOPIC_ANALYTICS). */
export const ANALYTICS_TOPIC_DEFAULT = "frameflow.analytics.v1";

export const ANALYTICS_EVENT_TYPES = [
  "GalleryViewed",
  "PhotoViewed",
  "PhotoDownloaded",
  "GalleryDownloaded",
  "GalleryShared",
] as const;

export type AnalyticsEventType = (typeof ANALYTICS_EVENT_TYPES)[number];

const uuidSchema = z.string().uuid();

const trafficSourceSchema = z.object({
  // "direct" (no referrer) | "unknown" (unparseable) | normalized hostname.
  source: z.string().min(1).max(100),
  medium: z.string().max(50).nullable(),
  campaign: z.string().max(50).nullable(),
});

export type TrafficSource = z.infer<typeof trafficSourceSchema>;

const eventBaseSchema = z.object({
  eventId: uuidSchema,
  eventType: z.enum(ANALYTICS_EVENT_TYPES),
  schemaVersion: z.literal(EVENT_SCHEMA_VERSION),
  occurredAt: z.string().datetime(),
  galleryId: uuidSchema,
  workspaceId: uuidSchema,
  // Pseudonymous first-party visitor id (client-minted UUID in localStorage,
  // resettable by clearing site data). Null when the client sent none.
  // An estimate input for unique-visitor math — never an identity.
  visitorId: uuidSchema.nullable(),
  // Links related emissions (unlock → photo views). Fresh UUID per unlock,
  // propagated through minted photo URLs.
  correlationId: z.string().min(1).max(200),
  trafficSource: trafficSourceSchema,
});

const galleryViewedSchema = eventBaseSchema.extend({
  eventType: z.literal("GalleryViewed"),
  photoCount: z.number().int().min(0),
});

const photoViewedSchema = eventBaseSchema.extend({
  eventType: z.literal("PhotoViewed"),
  photoId: uuidSchema,
});

const photoDownloadedSchema = eventBaseSchema.extend({
  eventType: z.literal("PhotoDownloaded"),
  photoId: uuidSchema,
});

const galleryDownloadedSchema = eventBaseSchema.extend({
  eventType: z.literal("GalleryDownloaded"),
  photoCount: z.number().int().min(0),
});

const gallerySharedSchema = eventBaseSchema.extend({
  eventType: z.literal("GalleryShared"),
  // Normalized client share channel (e.g. "clipboard", "native").
  channel: z.string().min(1).max(50),
});

const analyticsEventSchema = z.discriminatedUnion("eventType", [
  galleryViewedSchema,
  photoViewedSchema,
  photoDownloadedSchema,
  galleryDownloadedSchema,
  gallerySharedSchema,
]);

export type AnalyticsEvent = z.infer<typeof analyticsEventSchema>;

type NewEventInput = {
  galleryId: string;
  workspaceId: string;
  visitorId: string | null;
  correlationId: string;
  trafficSource: TrafficSource;
};

function baseFields(input: NewEventInput) {
  return {
    eventId: randomUUID(),
    schemaVersion: EVENT_SCHEMA_VERSION as 1,
    occurredAt: new Date().toISOString(),
    galleryId: input.galleryId,
    workspaceId: input.workspaceId,
    visitorId: input.visitorId,
    correlationId: input.correlationId,
    trafficSource: input.trafficSource,
  };
}

/** Emitted on successful gallery unlock (PIN verified). See Phase 5 for the view definition. */
export function makeGalleryViewed(
  input: NewEventInput & { photoCount: number }
): AnalyticsEvent {
  return { ...baseFields(input), eventType: "GalleryViewed", photoCount: input.photoCount };
}

/** Emitted when proxied photo bytes are served inline. */
export function makePhotoViewed(input: NewEventInput & { photoId: string }): AnalyticsEvent {
  return { ...baseFields(input), eventType: "PhotoViewed", photoId: input.photoId };
}

/** Emitted when proxied photo bytes are served as a download (dl=1). */
export function makePhotoDownloaded(
  input: NewEventInput & { photoId: string }
): AnalyticsEvent {
  return { ...baseFields(input), eventType: "PhotoDownloaded", photoId: input.photoId };
}

/** Emitted when a whole-gallery download completes (bulk export surface). */
export function makeGalleryDownloaded(
  input: NewEventInput & { photoCount: number }
): AnalyticsEvent {
  return { ...baseFields(input), eventType: "GalleryDownloaded", photoCount: input.photoCount };
}

/** Emitted when a visitor clicks a gallery share action. */
export function makeGalleryShared(input: NewEventInput & { channel: string }): AnalyticsEvent {
  return { ...baseFields(input), eventType: "GalleryShared", channel: input.channel };
}

/** Validate an inbound event (producer self-check, consumer gate). */
export function validateAnalyticsEvent(raw: unknown):
  | { ok: true; event: AnalyticsEvent }
  | { ok: false; error: string } {
  const parsed = analyticsEventSchema.safeParse(raw);
  if (parsed.success) return { ok: true, event: parsed.data };
  return { ok: false, error: "Invalid analytics event" };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Strict v4 shape (matches what the schema accepts): version nibble 1-8,
// variant nibble 8/9/a/b. Anything else was not minted by us.
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Visitor ids are opaque client-minted UUIDs. Anything else (missing,
 * malformed, tracking-looking) becomes null — never stored raw.
 */
export function parseVisitorId(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 100) return null;
  const v = raw.trim();
  return UUID_V4_RE.test(v) ? v.toLowerCase() : null;
}

/** Mint a fresh pseudonymous visitor id (returned to clients without one). */
export function mintVisitorId(): string {
  return randomUUID();
}

/** Mint a correlation id linking one unlock to its photo events. */
export function mintCorrelationId(): string {
  return randomUUID();
}

/**
 * Normalize untrusted traffic input: absent referrer → "direct",
 * unparseable → "unknown", otherwise the lowercased hostname without a
 * leading www. UTM medium/campaign pass through length-capped. Only the
 * hostname is kept — paths and query strings never enter the event.
 */
export function normalizeTrafficSource(
  refererHeader: unknown,
  query: Record<string, unknown>
): TrafficSource {
  let source = "direct";
  if (typeof refererHeader === "string" && refererHeader.length > 0) {
    try {
      const host = new URL(refererHeader).hostname.toLowerCase();
      source = host.replace(/^www\./, "").slice(0, 100) || "unknown";
    } catch {
      source = "unknown";
    }
  }
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v.slice(0, 50) : null;
  return { source, medium: str(query.utm_medium), campaign: str(query.utm_campaign) };
}
