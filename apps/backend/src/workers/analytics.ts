import { Kafka } from "kafkajs";

import { loadEnv } from "../config/env.js";
import { closePool } from "../lib/db.js";
import { ANALYTICS_TOPIC_DEFAULT } from "../lib/analytics-events.js";
import { processAnalyticsRecord } from "../lib/analytics-sink.js";

// ---------------------------------------------------------------------------
// Analytics consumer entrypoint — its own process, independent of the API:
//
//   KAFKA_BROKERS=localhost:9092 bun run worker:analytics      # dev
//   node dist/workers/analytics.js                             # prod service
//
// At-least-once with teeth: each message is validated + stored BEFORE its
// offset resolves, and offsets commit only after the whole batch's work
// succeeds. Restarts re-deliver uncommitted messages; the event_id primary
// key dedupes them. Invalid payloads log + resolve (poison can never wedge
// the consumer), which is safe precisely because the sink is idempotent.
// ---------------------------------------------------------------------------

/** Consumer group pins the contract generation: v2 events need a v2 group. */
export const ANALYTICS_CONSUMER_GROUP = "frameflow-analytics-v1";

function log(event: string, detail: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ scope: "analytics-consumer", event, ...detail }));
}

async function start(): Promise<void> {
  const env = loadEnv();
  const brokers = (env.KAFKA_BROKERS ?? "")
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean);
  if (brokers.length === 0) {
    console.error("KAFKA_BROKERS is required for the analytics consumer");
    process.exitCode = 1;
    return;
  }
  const topic = env.KAFKA_TOPIC_ANALYTICS ?? ANALYTICS_TOPIC_DEFAULT;

  const kafka = new Kafka({ clientId: "frameflow-analytics-consumer", brokers });
  const consumer = kafka.consumer({ groupId: ANALYTICS_CONSUMER_GROUP });

  const shutdown = async (signal: string) => {
    log("shutdown", { signal });
    // Commit-safe stop: finish the in-flight batch, then leave the group.
    await consumer.disconnect().catch(() => undefined);
    await closePool().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: false });
  log("ready", { topic, group: ANALYTICS_CONSUMER_GROUP });

  await consumer.run({
    autoCommit: false,
    eachBatchAutoResolve: false,
    eachBatch: async ({ batch, resolveOffset, heartbeat, commitOffsetsIfNecessary }) => {
      let stored = 0;
      let duplicates = 0;
      let invalid = 0;
      for (const message of batch.messages) {
        let raw: unknown = null;
        try {
          raw = message.value ? JSON.parse(message.value.toString()) : null;
        } catch {
          raw = null;
        }
        try {
          const outcome = await processAnalyticsRecord(env, raw);
          if (outcome === "stored") stored += 1;
          else if (outcome === "duplicate") duplicates += 1;
          else invalid += 1;
        } catch (err) {
          // DB down mid-batch: do NOT resolve — the offset stays put and the
          // whole batch redelivers after restart. Throw to stop this batch.
          log("batch-aborted", { error: (err as Error).message });
          throw err;
        }
        // Resolved only after the store succeeded (or was safely skippable).
        resolveOffset(message.offset);
        await heartbeat();
      }
      await commitOffsetsIfNecessary();
      log("batch", {
        topic: batch.topic,
        partition: batch.partition,
        stored,
        duplicates,
        invalid,
      });
    },
  });
}

const invokedDirectly =
  process.argv[1] && /workers\/analytics\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) {
  void start();
}
