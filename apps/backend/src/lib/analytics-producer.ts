import { Kafka, type Producer } from "kafkajs";

import type { Env } from "../config/env.js";
import {
  ANALYTICS_TOPIC_DEFAULT,
  validateAnalyticsEvent,
  type AnalyticsEvent,
} from "./analytics-events.js";
import { analyticsPublishesTotal } from "./metrics.js";

// ---------------------------------------------------------------------------
// Analytics event producer (fire-and-forget).
//
// KAFKA_BROKERS is OPTIONAL: unset → publish is a no-op so the API runs
// without Kafka (local dev, tests). When set, events validate against the
// versioned contract, key by galleryId (ordering per gallery, even spread),
// and send with acks=all. publishAnalyticsEvent NEVER throws and NEVER
// blocks the caller long: failures log (message only) and callers proceed —
// analytics must not take down gallery serving. Crash-window loss is accepted
// and documented (aggregates are estimates; the sink dedupes redelivery).
// ---------------------------------------------------------------------------

/** Publish timeout: slow Kafka must not stall request handling. */
export const ANALYTICS_PUBLISH_TIMEOUT_MS = 3_000;

let kafka: Kafka | null = null;
let producer: Producer | null = null;
let brokersForClient: string | null = null;

function brokersOf(env: Env): string[] {
  return (env.KAFKA_BROKERS ?? "")
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean);
}

function log(event: string, detail: string): void {
  console.log(JSON.stringify({ scope: "analytics-producer", event, detail }));
}

async function getProducer(env: Env): Promise<Producer | null> {
  const brokers = brokersOf(env);
  if (brokers.length === 0) return null;
  const key = brokers.join(",");
  if (!producer || brokersForClient !== key) {
    await producer?.disconnect().catch(() => undefined);
    brokersForClient = key;
    kafka = new Kafka({
      clientId: "frameflow-api",
      brokers,
      retry: { retries: 2 },
    });
    producer = kafka.producer({ allowAutoTopicCreation: true });
  }
  return producer;
}

export function analyticsTopic(env: Env): string {
  return env.KAFKA_TOPIC_ANALYTICS ?? ANALYTICS_TOPIC_DEFAULT;
}

export type AnalyticsPublishResult = { published: boolean; reason?: string };

/** Validate + publish one event. Never throws; never blocks long. */
export async function publishAnalyticsEvent(
  env: Env,
  event: AnalyticsEvent
): Promise<AnalyticsPublishResult> {
  const checked = validateAnalyticsEvent(event);
  if (!checked.ok) {
    log("dropped-invalid", checked.error);
    analyticsPublishesTotal.inc({ outcome: "invalid" });
    return { published: false, reason: "invalid-event" };
  }
  const active = await getProducer(env).catch((err: unknown) => {
    log("connect-failed", (err as Error).message);
    analyticsPublishesTotal.inc({ outcome: "failed" });
    return null;
  });
  if (!active) return { published: false, reason: "kafka-unconfigured" };
  try {
    const send = (async () => {
      await active.connect().catch(() => undefined);
      await active.send({
        topic: analyticsTopic(env),
        messages: [{ key: event.galleryId, value: JSON.stringify(event) }],
      });
    })();
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Analytics publish timed out")), ANALYTICS_PUBLISH_TIMEOUT_MS);
    });
    await Promise.race([send, timeout]);
    analyticsPublishesTotal.inc({ outcome: "published" });
    return { published: true };
  } catch (err) {
    log("publish-failed", (err as Error).message);
    analyticsPublishesTotal.inc({ outcome: "failed" });
    return { published: false, reason: "publish-failed" };
  }
}

/** Test helper: drop cached clients so new broker settings take effect. */
export async function resetAnalyticsProducer(): Promise<void> {
  const p = producer;
  producer = null;
  kafka = null;
  brokersForClient = null;
  await p?.disconnect().catch(() => undefined);
}
