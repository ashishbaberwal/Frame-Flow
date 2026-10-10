import { Queue, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";

import type { Env } from "../config/env.js";

// ---------------------------------------------------------------------------
// Redis + BullMQ connection management.
//
// REDIS_URL is OPTIONAL: without it the queue layer reports unconfigured and
// callers fall back to in-process work (thumbnail sweep). With it, producers
// publish jobs and the worker entrypoint (src/workers/thumbnails.ts)
// processes them. Nothing here ever logs the URL — only failure messages.
// ---------------------------------------------------------------------------

export const DERIVATIVE_QUEUE_NAME = "frameflow-derivatives";

/** Job attempts at the transport level (PG attempts are the real budget). */
export const JOB_ATTEMPTS = 3;
/** Exponential backoff between transport retries (5s, 25s, 125s). */
export const JOB_BACKOFF_MS = 5_000;
/**
 * Processor-level job timeout: BullMQ has no job-timeout option, so the
 * worker races each job against this. Expiry throws, BullMQ retries with
 * backoff, and the PG row stays PROCESSING for the reconciler backstop.
 */
export const JOB_TIMEOUT_MS = 120_000;
/** Bounded retries per sweep batch — mirrors the PG sweep batch. */
export const RECONCILE_BATCH = 100;

const defaultJobOptions: JobsOptions = {
  attempts: JOB_ATTEMPTS,
  backoff: { type: "exponential", delay: JOB_BACKOFF_MS },
  removeOnComplete: 100,
  removeOnFail: 500,
};

let connection: Redis | null = null;
let derivativeQueue: Queue | null = null;
let connectionForUrl: string | null = null;

function log(event: string, detail: string): void {
  console.log(JSON.stringify({ scope: "queue", event, detail }));
}

/** Shared Redis connection. BullMQ requires maxRetriesPerRequest: null. */
export function getRedisConnection(env: Env): Redis | null {
  if (!env.REDIS_URL) return null;
  if (!connection || connectionForUrl !== env.REDIS_URL) {
    void connection?.quit().catch(() => undefined);
    connectionForUrl = env.REDIS_URL;
    connection = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    connection.on("error", (err) => {
      // Message only — the URL carries no credentials into logs.
      log("connection-error", (err as Error).message);
    });
  }
  return connection;
}

/** The derivative job queue, or null when Redis is not configured. */
export function getDerivativeQueue(env: Env): Queue | null {
  const conn = getRedisConnection(env);
  if (!conn) return null;
  if (!derivativeQueue) {
    derivativeQueue = new Queue(DERIVATIVE_QUEUE_NAME, {
      connection: conn,
      defaultJobOptions,
    });
  }
  return derivativeQueue;
}

/** True when REDIS_URL is set (jobs publish to BullMQ instead of inline). */
export function isQueueConfigured(env: Env): boolean {
  return Boolean(env.REDIS_URL);
}

/** Test helper: drop cached clients so a new REDIS_URL takes effect. */
export function resetQueueState(): void {
  derivativeQueue = null;
  connectionForUrl = null;
  const conn = connection;
  connection = null;
  void conn?.quit().catch(() => undefined);
}
