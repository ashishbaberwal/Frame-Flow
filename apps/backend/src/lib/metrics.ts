import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";

import type { Env } from "../config/env.js";
import { DERIVATIVE_QUEUE_NAME, getDerivativeQueue } from "./queue.js";

// ---------------------------------------------------------------------------
// Prometheus metrics (Phase 9).
//
// One registry per process, exposed over HTTP: the API serves /metrics, the
// workers run a small sidecar server on METRICS_PORT (9464/9465). Every
// metric is a plain in-process counter/gauge/histogram — nothing here talks
// to the monitoring stack, so Prometheus or Grafana being down can never
// affect request serving (degrade-safe by construction).
//
// Label cardinality is a hard rule: labels come only from bounded sets
// (route PATTERNS such as "/api/v1/events/:id/photos", HTTP methods, status
// codes, queue names, fixed outcome enums, topic partitions). Visitor ids,
// gallery ids, user ids, emails and raw URLs are NEVER labels. The route
// label is derived from Express's matched route pattern, and unmatched
// requests collapse into a single "unmatched" series.
// ---------------------------------------------------------------------------

export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

export const httpRequestsTotal = new Counter({
  name: "frameflow_http_requests_total",
  help: "HTTP requests by method, normalized route pattern, and status code",
  labelNames: ["method", "route", "status"] as const,
  registers: [metricsRegistry],
});

export const httpRequestDuration = new Histogram({
  name: "frameflow_http_request_duration_seconds",
  help: "HTTP request duration by method and normalized route pattern",
  labelNames: ["method", "route"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

export const dbQueryDuration = new Histogram({
  name: "frameflow_db_query_duration_seconds",
  help: "PostgreSQL query duration by statement kind (from the pool wrapper)",
  labelNames: ["op"] as const,
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [metricsRegistry],
});

export const redisErrorsTotal = new Counter({
  name: "frameflow_redis_errors_total",
  help: "Redis operation failures by component (requests degrade, never fail)",
  labelNames: ["component"] as const,
  registers: [metricsRegistry],
});

export const analyticsPublishesTotal = new Counter({
  name: "frameflow_analytics_publishes_total",
  help: "Analytics events by publish outcome (producer side)",
  labelNames: ["outcome"] as const,
  registers: [metricsRegistry],
});

export const analyticsEventsTotal = new Counter({
  name: "frameflow_analytics_events_total",
  help: "Analytics events by store outcome (consumer side)",
  labelNames: ["outcome"] as const,
  registers: [metricsRegistry],
});

export const analyticsBatchErrorsTotal = new Counter({
  name: "frameflow_analytics_batch_errors_total",
  help: "Analytics consumer batches aborted by storage errors",
  registers: [metricsRegistry],
});

/**
 * Set by the analytics worker via registerConsumerLagCollector; the gauge's
 * collect callback reads it at scrape time. Async failures keep the
 * previous values (a stale gauge beats a lying zero).
 */
let consumerLagFetcher:
  | (() => Promise<Array<{ topic: string; partition: number; lag: number }>>)
  | null = null;

export const analyticsConsumerLag = new Gauge({
  name: "frameflow_analytics_consumer_lag",
  help: "Kafka consumer lag by topic and partition (collected at scrape time)",
  labelNames: ["topic", "partition"] as const,
  registers: [metricsRegistry],
  collect: async () => {
    const fetchLag = consumerLagFetcher;
    if (!fetchLag) return;
    try {
      const rows = await fetchLag();
      for (const row of rows) {
        analyticsConsumerLag.set({ topic: row.topic, partition: String(row.partition) }, row.lag);
      }
    } catch {
      // Kafka admin unreachable — keep the previous values.
    }
  },
});

export const derivativeJobsTotal = new Counter({
  name: "frameflow_derivative_jobs_total",
  help: "Thumbnail derivative job outcomes (ready, failed, skipped)",
  labelNames: ["outcome"] as const,
  registers: [metricsRegistry],
});

export const derivativeJobDuration = new Histogram({
  name: "frameflow_derivative_job_duration_seconds",
  help: "Thumbnail derivative job processing duration",
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [metricsRegistry],
});

export const bullmqJobsTotal = new Counter({
  name: "frameflow_bullmq_jobs_total",
  help: "BullMQ job events by queue (completed, failed)",
  labelNames: ["queue", "event"] as const,
  registers: [metricsRegistry],
});

export const bullmqJobRetriesTotal = new Counter({
  name: "frameflow_bullmq_job_retries_total",
  help: "BullMQ job failures that will be retried (attempts remaining)",
  labelNames: ["queue"] as const,
  registers: [metricsRegistry],
});

export const bullmqWorkerConcurrency = new Gauge({
  name: "frameflow_bullmq_worker_concurrency",
  help: "Configured BullMQ worker concurrency per queue",
  labelNames: ["queue"] as const,
  registers: [metricsRegistry],
});

/**
 * Set by registerQueueMetrics when Redis is configured. The collect callback
 * below reads it at scrape time; without it the gauges simply don't emit.
 */
let queueMetricsEnv: Env | null = null;

export const queueJobs = new Gauge({
  name: "frameflow_queue_jobs",
  help: "BullMQ queue depth by state (collected at scrape time)",
  labelNames: ["queue", "state"] as const,
  registers: [metricsRegistry],
  collect: async () => {
    const env = queueMetricsEnv;
    if (!env) return;
    try {
      const queue = getDerivativeQueue(env);
      if (!queue) return;
      const counts = (await queue.getJobCounts("waiting", "active", "delayed", "failed")) as Record<
        string,
        number
      >;
      for (const state of ["waiting", "active", "delayed", "failed"] as const) {
        queueJobs.set({ queue: DERIVATIVE_QUEUE_NAME, state }, counts[state] ?? 0);
      }
      const oldest = await queue.getWaiting(0, 0);
      const job = oldest[0];
      if (job?.timestamp) {
        queueOldestWaitingAge.set(
          { queue: DERIVATIVE_QUEUE_NAME },
          Math.max(0, (Date.now() - job.timestamp) / 1000)
        );
      } else {
        queueOldestWaitingAge.set({ queue: DERIVATIVE_QUEUE_NAME }, 0);
      }
    } catch {
      // Redis unreachable at scrape time — keep the previous values.
    }
  },
});

export const queueOldestWaitingAge = new Gauge({
  name: "frameflow_queue_oldest_waiting_age_seconds",
  help: "Age of the oldest waiting job in the derivative queue",
  labelNames: ["queue"] as const,
  registers: [metricsRegistry],
});

// ---------------------------------------------------------------------------
// Exposure policy
// ---------------------------------------------------------------------------

/**
 * Metrics are enabled when METRICS_ENABLED=true, or by default in local
 * development (the compose stack scrapes out of the box). Tests and
 * production stay off unless opted in explicitly.
 */
export function metricsEnabled(env: Env): boolean {
  if (env.METRICS_ENABLED === "true") return true;
  if (env.METRICS_ENABLED === "false") return false;
  return env.NODE_ENV === "development";
}

/** Constant-time bearer check for the /metrics surface. */
export function verifyMetricsToken(
  headerValue: string | undefined,
  token: string
): boolean {
  if (!headerValue) return false;
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  const received = createHash("sha256").update(headerValue).digest();
  return timingSafeEqual(expected, received);
}

/**
 * Standalone metrics server for worker processes (no Express there). Binds
 * 0.0.0.0 on METRICS_PORT (default per worker) so the dev compose Prometheus
 * can scrape from its container. Never throws — a taken port logs and the
 * worker keeps processing.
 */
export function startMetricsServer(env: Env, scope: string, defaultPort: number): void {
  if (!metricsEnabled(env)) return;
  const port = env.METRICS_PORT ?? defaultPort;
  const server = http.createServer((req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    if (env.METRICS_TOKEN && !verifyMetricsToken(req.headers.authorization, env.METRICS_TOKEN)) {
      res.writeHead(401, { "content-type": "application/json" }).end('{"error":"Unauthorized"}');
      return;
    }
    metricsRegistry
      .metrics()
      .then((body) => {
        res.writeHead(200, { "content-type": metricsRegistry.contentType }).end(body);
      })
      .catch(() => {
        res.writeHead(500).end();
      });
  });
  server.on("error", (err) => {
    log("metrics-server-error", scope, (err as Error).message);
  });
  server.listen(port, "0.0.0.0", () => {
    log("metrics-ready", scope, String(port));
  });
}

// ---------------------------------------------------------------------------
// Scrape-time collector registration
// ---------------------------------------------------------------------------

/**
 * Enable the queue-depth gauges for this process. Called by the API when
 * Redis is configured and by the thumbnail worker; without it the gauges
 * don't emit (Redis is optional infrastructure).
 */
export function registerQueueMetrics(env: Env): void {
  if (!env.REDIS_URL) return;
  queueMetricsEnv = env;
}

/**
 * Attach the consumer-lag source. The caller (analytics worker) supplies the
 * Kafka admin fetch; see consumerLagFetcher above for the failure policy.
 */
export function registerConsumerLagCollector(
  fetchLag: () => Promise<Array<{ topic: string; partition: number; lag: number }>>
): void {
  consumerLagFetcher = fetchLag;
}

function log(event: string, scope: string, detail: string): void {
  console.log(JSON.stringify({ scope: `metrics-${scope}`, event, detail }));
}

/** Test helper: zero all metric values (collectors stay registered). */
export function resetMetricsForTests(): void {
  metricsRegistry.resetMetrics();
}
