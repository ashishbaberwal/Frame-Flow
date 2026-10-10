import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 4 pipeline: producer policy (mocked Kafka) and the idempotent PG
 * sink (real Postgres). Route emission is covered in commit C; here the
 * contract is: invalid events never leave the process, failures never
 * throw, and redelivery never duplicates rows.
 */

vi.mock("kafkajs", () => ({
  Kafka: class {
    opts: unknown;
    constructor(opts: unknown) {
      this.opts = opts;
    }
    producer() {
      return {
        connect: async () => undefined,
        disconnect: async () => undefined,
        send: async (req: unknown) => {
          const g = globalThis as Record<string, unknown>;
          if (g.__kafkaFail) throw new Error("Kafka is down");
          if (!Array.isArray(g.__kafkaSent)) g.__kafkaSent = [];
          (g.__kafkaSent as unknown[]).push(req);
        },
      };
    }
  },
}));

import { resetEnvCache } from "../src/config/env.js";
import { closePool, getPool } from "../src/lib/db.js";
import {
  makeGalleryViewed,
  makePhotoViewed,
  type AnalyticsEvent,
} from "../src/lib/analytics-events.js";
import {
  publishAnalyticsEvent,
  resetAnalyticsProducer,
} from "../src/lib/analytics-producer.js";
import { processAnalyticsRecord } from "../src/lib/analytics-sink.js";
import type { Env } from "../src/config/env.js";

async function loadTestEnv(): Promise<Env> {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? "postgresql://test:test@localhost:5432/test";
  process.env.CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY ?? "sk_test_placeholder";
  process.env.APPWRITE_ENDPOINT =
    process.env.APPWRITE_ENDPOINT ?? "https://cloud.appwrite.io/v1";
  process.env.APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID ?? "test-project";
  process.env.APPWRITE_API_KEY = process.env.APPWRITE_API_KEY ?? "test-key";
  process.env.APPWRITE_BUCKET_ID = process.env.APPWRITE_BUCKET_ID ?? "test-bucket";
  resetEnvCache();
  const { loadEnv } = await import("../src/config/env.js");
  return loadEnv();
}

const dbUrl = process.env.TEST_DATABASE_URL;
const hasDb = !!dbUrl;
const describeIf = (cond: boolean) => (cond ? describe : describe.skip);

const GALLERY_ID = "51111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "52222222-2222-4222-8222-222222222222";
const PHOTO_ID = "53333333-3333-4333-8333-333333333333";

function base() {
  return {
    galleryId: GALLERY_ID,
    workspaceId: WORKSPACE_ID,
    visitorId: null,
    correlationId: "corr-pipe-1",
    trafficSource: { source: "direct" as const, medium: null, campaign: null },
  };
}

function sent(): { topic: string; messages: { key: string; value: string }[] }[] {
  return ((globalThis as Record<string, unknown>).__kafkaSent as never[]) ?? [];
}

describeIf(hasDb)("Analytics pipeline", () => {
  let env: Env;

  beforeEach(async () => {
    (globalThis as Record<string, unknown>).__kafkaSent = [];
    (globalThis as Record<string, unknown>).__kafkaFail = false;
    delete process.env.KAFKA_BROKERS;
    await resetAnalyticsProducer();
    env = await loadTestEnv();
  });

  afterAll(async () => {
    await resetAnalyticsProducer();
    await getPool(env)
      .query("DELETE FROM analytics_event_log WHERE workspace_id = $1", [WORKSPACE_ID])
      .catch(() => undefined);
    await closePool();
  });

  it("is a no-op without brokers", async () => {
    const result = await publishAnalyticsEvent(env, makeGalleryViewed({ ...base(), photoCount: 3 }));
    expect(result).toEqual({ published: false, reason: "kafka-unconfigured" });
    expect(sent().length).toBe(0);
  });

  it("drops invalid events before touching Kafka", async () => {
    process.env.KAFKA_BROKERS = "localhost:9092";
    env = await loadTestEnv();
    const bad = { ...makeGalleryViewed({ ...base(), photoCount: 1 }), galleryId: "nope" };
    const result = await publishAnalyticsEvent(env, bad as unknown as AnalyticsEvent);
    expect(result).toEqual({ published: false, reason: "invalid-event" });
    expect(sent().length).toBe(0);
  });

  it("sends valid events to the topic keyed by gallery", async () => {
    process.env.KAFKA_BROKERS = "localhost:9092";
    env = await loadTestEnv();
    const event = makePhotoViewed({ ...base(), photoId: PHOTO_ID });
    const result = await publishAnalyticsEvent(env, event);
    expect(result).toEqual({ published: true });
    expect(sent().length).toBe(1);
    expect(sent()[0]!.topic).toBe("frameflow.analytics.v1");
    expect(sent()[0]!.messages[0]!.key).toBe(GALLERY_ID);
    expect(JSON.parse(sent()[0]!.messages[0]!.value)).toMatchObject({
      eventId: event.eventId,
      eventType: "PhotoViewed",
    });
  });

  it("producer failure returns false instead of throwing", async () => {
    process.env.KAFKA_BROKERS = "localhost:9092";
    env = await loadTestEnv();
    (globalThis as Record<string, unknown>).__kafkaFail = true;
    const result = await publishAnalyticsEvent(
      env,
      makeGalleryViewed({ ...base(), photoCount: 1 })
    );
    expect(result).toEqual({ published: false, reason: "publish-failed" });
  });

  it("sink stores, dedupes redelivery, and skips invalid payloads", async () => {
    const event = makePhotoViewed({ ...base(), photoId: PHOTO_ID });
    expect(await processAnalyticsRecord(env, event)).toBe("stored");
    expect(await processAnalyticsRecord(env, event)).toBe("duplicate");
    expect(await processAnalyticsRecord(env, { nope: true })).toBe("invalid");

    const rows = await getPool(env).query<{ event_id: string; photo_id: string }>(
      "SELECT event_id, photo_id::text AS photo_id FROM analytics_event_log WHERE event_id = $1",
      [event.eventId]
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]!.photo_id).toBe(PHOTO_ID);
  });
});

if (!hasDb) {
  console.warn("TEST_DATABASE_URL not set — skipping analytics pipeline tests");
}
