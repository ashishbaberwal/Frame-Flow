import { describe, expect, it } from "vitest";

import {
  EVENT_SCHEMA_VERSION,
  makeGalleryDownloaded,
  makeGalleryShared,
  makeGalleryViewed,
  makePhotoDownloaded,
  makePhotoViewed,
  normalizeTrafficSource,
  parseVisitorId,
  validateAnalyticsEvent,
} from "../src/lib/analytics-events.js";

/**
 * Phase 4 event contracts: builders emit schema-valid events, validation
 * accepts every defined type and rejects malformed input, and untrusted
 * traffic/visitor inputs normalize safely. No DB, no Kafka — pure contract.
 */

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const PHOTO_ID = "33333333-3333-4333-8333-333333333333";
const VISITOR_ID = "44444444-4444-4444-8444-444444444444";

function base() {
  return {
    galleryId: GALLERY_ID,
    workspaceId: WORKSPACE_ID,
    visitorId: VISITOR_ID,
    correlationId: "corr-1",
    trafficSource: { source: "direct", medium: null, campaign: null },
  };
}

describe("Analytics event contracts", () => {
  it("builders emit valid v1 events with fresh ids and timestamps", () => {
    const viewed = makeGalleryViewed({ ...base(), photoCount: 12 });
    const photo = makePhotoViewed({ ...base(), photoId: PHOTO_ID });
    const dl = makePhotoDownloaded({ ...base(), photoId: PHOTO_ID });
    const gdl = makeGalleryDownloaded({ ...base(), photoCount: 12 });
    const shared = makeGalleryShared({ ...base(), channel: "clipboard" });

    for (const e of [viewed, photo, dl, gdl, shared]) {
      expect(validateAnalyticsEvent(e)).toMatchObject({ ok: true });
      expect(e.schemaVersion).toBe(EVENT_SCHEMA_VERSION);
    }
    const ids = new Set([viewed, photo, dl, gdl, shared].map((e) => e.eventId));
    expect(ids.size).toBe(5);
    for (const e of [viewed, photo, dl, gdl, shared]) {
      expect(Date.parse(e.occurredAt)).not.toBeNaN();
    }
  });

  it("rejects unknown types, wrong versions, and bad ids", () => {
    const good = makePhotoViewed({ ...base(), photoId: PHOTO_ID });
    expect(validateAnalyticsEvent({ ...good, eventType: "Hacked" }).ok).toBe(false);
    expect(validateAnalyticsEvent({ ...good, schemaVersion: 2 }).ok).toBe(false);
    expect(validateAnalyticsEvent({ ...good, galleryId: "not-a-uuid" }).ok).toBe(false);
    expect(validateAnalyticsEvent({ ...good, photoId: "xyz" }).ok).toBe(false);
    expect(validateAnalyticsEvent({ ...good, occurredAt: "yesterday" }).ok).toBe(false);
    expect(validateAnalyticsEvent(null).ok).toBe(false);
    expect(validateAnalyticsEvent({}).ok).toBe(false);
  });

  it("never carries secrets: unknown fields are stripped, no secret fields exist", () => {
    const good = makeGalleryViewed({ ...base(), photoCount: 1 });
    const withExtra = validateAnalyticsEvent({
      ...good,
      pin: "123456",
      token: "secret",
      email: "a@b.c",
    });
    expect(withExtra.ok).toBe(true);
    if (withExtra.ok) {
      expect(withExtra.event).not.toHaveProperty("pin");
      expect(withExtra.event).not.toHaveProperty("token");
      expect(withExtra.event).not.toHaveProperty("email");
      expect(Object.keys(withExtra.event).sort()).toEqual(
        [
          "correlationId",
          "eventId",
          "eventType",
          "galleryId",
          "occurredAt",
          "photoCount",
          "schemaVersion",
          "trafficSource",
          "visitorId",
          "workspaceId",
        ].sort()
      );
    }
  });

  it("normalizes traffic sources: direct, unknown, and hostnames", () => {
    expect(normalizeTrafficSource(undefined, {}).source).toBe("direct");
    expect(normalizeTrafficSource("", {}).source).toBe("direct");
    expect(normalizeTrafficSource("not a url", {}).source).toBe("unknown");
    expect(normalizeTrafficSource("https://www.google.com/search?q=x", {}).source).toBe(
      "google.com"
    );
    expect(normalizeTrafficSource("https://m.site.example/a?b=c", {}).source).toBe(
      "m.site.example"
    );
    const utm = normalizeTrafficSource("https://x.example/", {
      utm_medium: "social",
      utm_campaign: "launch",
    });
    expect(utm).toMatchObject({ medium: "social", campaign: "launch" });
    // Paths and query strings never leak into the source.
    expect(normalizeTrafficSource("https://x.example/s3cr3t?token=abc", {}).source).toBe(
      "x.example"
    );
  });

  it("accepts only well-formed visitor ids", () => {
    expect(parseVisitorId(VISITOR_ID)).toBe(VISITOR_ID.toLowerCase());
    expect(parseVisitorId(VISITOR_ID.toUpperCase())).toBe(VISITOR_ID.toLowerCase());
    expect(parseVisitorId(undefined)).toBeNull();
    expect(parseVisitorId("")).toBeNull();
    expect(parseVisitorId("not-a-uuid")).toBeNull();
    expect(parseVisitorId("x".repeat(101))).toBeNull();
    expect(parseVisitorId(12345)).toBeNull();
  });
});
