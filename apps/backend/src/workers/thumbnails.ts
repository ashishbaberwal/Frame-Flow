import { Worker, type Job } from "bullmq";

import { loadEnv, type Env } from "../config/env.js";
import { closePool } from "../lib/db.js";
import {
  DERIVATIVE_JOB_NAME,
  RECONCILE_JOB_NAME,
  reconcileDerivativeJobs,
} from "../lib/derivative-jobs.js";
import { processDerivativeJob } from "../lib/derivatives.js";
import { getDerivativeQueue, getRedisConnection, JOB_TIMEOUT_MS, RECONCILE_BATCH } from "../lib/queue.js";

// ---------------------------------------------------------------------------
// Thumbnail worker entrypoint — runs as its own process, separate from the
// API server:
//
//   bun run worker:thumbnails        # dev (tsx watch)
//   node dist/workers/thumbnails.js  # prod (separate Render service)
//
// REDIS_URL is required here (fail fast); the API server treats it as
// optional and falls back to the in-process sweep instead.
// ---------------------------------------------------------------------------

const WORKER_CONCURRENCY = 2;
const RECONCILE_EVERY_MS = 60_000;

function log(event: string, detail: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ scope: "thumbnail-worker", event, ...detail }));
}

type DerivativeJobData = { photoId: string; variant: string };

async function processor(env: Env, job: Job): Promise<unknown> {
  if (job.name === RECONCILE_JOB_NAME) {
    const result = await reconcileDerivativeJobs(env);
    log("reconciled", { recovered: result.recovered, published: result.published });
    return result;
  }
  if (job.name === DERIVATIVE_JOB_NAME) {
    const data = job.data as DerivativeJobData;
    // BullMQ has no job-timeout option: race the work against the timeout so
    // a hung transform throws, retries with backoff, and never wedges a
    // concurrency slot. The PG row stays PROCESSING for the reconciler.
    const outcome = await withTimeout(
      processDerivativeJob(env, data),
      JOB_TIMEOUT_MS,
      `Derivative job timed out (${data.photoId}/${data.variant})`
    );
    log("job-done", { jobId: job.id, outcome: outcome.outcome, photoId: data.photoId });
    return outcome;
  }
  throw new Error(`Unknown job name: ${job.name}`);
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

async function start(): Promise<void> {
  const env = loadEnv();
  if (!env.REDIS_URL) {
    console.error("REDIS_URL is required for the thumbnail worker");
    process.exitCode = 1;
    return;
  }

  const connection = getRedisConnection(env)!;
  const queue = getDerivativeQueue(env)!;

  // Periodic recovery: requeue crashed rows and (re)publish anything still
  // needing work (e.g. photos created while Redis was down). A named job
  // scheduler dedupes itself — restarting the worker never double-schedules.
  await queue.upsertJobScheduler(
    "reconcile",
    { every: RECONCILE_EVERY_MS },
    { name: RECONCILE_JOB_NAME, data: {} }
  );

  const worker = new Worker(
    queue.name,
    (job) => processor(env, job),
    { connection, concurrency: WORKER_CONCURRENCY }
  );

  worker.on("completed", (job) => {
    log("completed", { jobId: job.id, name: job.name });
  });
  worker.on("failed", (job, err) => {
    // Message only — job data can carry photo ids but never secrets.
    log("failed", { jobId: job?.id, name: job?.name, error: err.message });
  });
  worker.on("error", (err) => {
    log("worker-error", { error: (err as Error).message });
  });

  log("ready", { concurrency: WORKER_CONCURRENCY, batch: RECONCILE_BATCH });

  const shutdown = async (signal: string) => {
    log("shutdown", { signal });
    // Stop taking new jobs, finish the active ones, then release everything.
    await worker.close().catch(() => undefined);
    await queue.close().catch(() => undefined);
    await closePool().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

const invokedDirectly =
  process.argv[1] && /workers\/thumbnails\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) {
  void start();
}
