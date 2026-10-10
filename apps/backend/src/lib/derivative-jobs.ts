import type { Env } from "../config/env.js";
import {
  MAX_DERIVATIVE_ATTEMPTS,
  recoverStuckDerivatives,
  type DerivativeVariant,
} from "./derivatives.js";
import { getDerivativeQueue } from "./queue.js";
import { getPool } from "./db.js";

// ---------------------------------------------------------------------------
// Queue producers for thumbnail jobs. Routes call these — never BullMQ
// directly — so retry/backoff/identity policy lives in one place and the
// Phase 3 swap stays out of HTTP handlers.
// ---------------------------------------------------------------------------

export const DERIVATIVE_JOB_NAME = "derivative";
export const RECONCILE_JOB_NAME = "reconcile";

/** Stable identity: one job slot per (photo, variant), forever. */
export function derivativeJobId(photoId: string, variant: string): string {
  return `dv:${photoId}:${variant}`;
}

export type PublishResult = { published: boolean; reason?: string };

/**
 * Publish one job per variant. Idempotent: the jobId is stable, so repeat
 * publishes collapse onto the in-flight job, and the worker skips READY rows
 * while the PG claim serializes real work. Throws on connection failure —
 * the caller logs and the photo stays QUEUED for the reconciler.
 */
export async function publishDerivativeJobs(
  env: Env,
  photoId: string,
  variants: DerivativeVariant[] = ["thumb_small", "thumb_large"]
): Promise<PublishResult> {
  const queue = getDerivativeQueue(env);
  if (!queue) return { published: false, reason: "queue-unconfigured" };
  await Promise.all(
    variants.map((variant) =>
      queue.add(
        DERIVATIVE_JOB_NAME,
        { photoId, variant },
        { jobId: derivativeJobId(photoId, variant) }
      )
    )
  );
  return { published: true };
}

export type ReconcileResult = { recovered: number; published: number };

/**
 * Recovery sweep (runs as a repeatable BullMQ job in the worker):
 * requeue crashed rows, then (re)publish jobs for every row still needing
 * work. This is the documented alternative to a transactional outbox — see
 * README "Background jobs": bounded ≤60s lag, no extra tables, idempotent
 * jobs make redelivery safe. A photo created while Redis is down simply
 * waits here as QUEUED instead of being lost.
 */
export async function reconcileDerivativeJobs(env: Env): Promise<ReconcileResult> {
  const queue = getDerivativeQueue(env);
  if (!queue) return { recovered: 0, published: 0 };
  const recovered = await recoverStuckDerivatives(env);
  const pending = await getPool(env).query<{ photo_id: string; variant: string }>(
    `SELECT photo_id, variant FROM photo_derivatives
     WHERE status = 'QUEUED' OR (status = 'FAILED' AND attempts < $1)
     ORDER BY created_at ASC
     LIMIT $2`,
    [MAX_DERIVATIVE_ATTEMPTS, 100]
  );
  await Promise.all(
    pending.rows.map((r) =>
      queue.add(
        DERIVATIVE_JOB_NAME,
        { photoId: r.photo_id, variant: r.variant },
        { jobId: derivativeJobId(r.photo_id, r.variant) }
      )
    )
  );
  return { recovered, published: pending.rows.length };
}
