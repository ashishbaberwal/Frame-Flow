import sharp from "sharp";

import type { Env } from "../config/env.js";
import { getPool, type DbPhoto } from "./db.js";
import { readPhotoBytes, uploadPhoto } from "./storage.js";

// ---------------------------------------------------------------------------
// Image derivatives (Phase 2).
//
// Originals are never modified: each variant is a new Appwrite object whose
// identity is the (photo_id, variant) pair. Status lives in PostgreSQL
// (photo_derivatives) — the single source of truth for "is this thumbnail
// ready". Routes only ever enqueue (INSERT) and trigger; all expensive work
// happens in sweepDerivativeQueue, which runs off the response path.
// Phase 3 replaces kickDerivativeWorker's body with a BullMQ publish — the
// enqueue + sweep seam stays the same.
// ---------------------------------------------------------------------------

export const DERIVATIVE_VARIANTS = [
  { name: "thumb_small", width: 320 },
  { name: "thumb_large", width: 960 },
] as const;

export type DerivativeVariant = (typeof DERIVATIVE_VARIANTS)[number]["name"];

const VARIANT_NAMES = new Set<string>(DERIVATIVE_VARIANTS.map((v) => v.name));

export function isDerivativeVariant(v: string): v is DerivativeVariant {
  return VARIANT_NAMES.has(v);
}

/** Input images larger than this in either axis are rejected, not processed. */
export const MAX_IMAGE_DIMENSION = 12_000;
/** Decompression-bomb guard: sharp refuses inputs above this pixel count. */
export const MAX_IMAGE_PIXELS = 50_000_000;
/** A FAILED row with fewer attempts is retried by the sweep; at MAX it rests. */
export const MAX_DERIVATIVE_ATTEMPTS = 3;
/** PROCESSING rows older than this are presumed crashed and re-queued. */
export const STUCK_PROCESSING_MS = 5 * 60 * 1000;
/** Rows claimed per sweep iteration — bounds one sweep's memory/time. */
const SWEEP_BATCH = 10;

export type DerivativeStatus = "QUEUED" | "PROCESSING" | "READY" | "FAILED";

export type DbDerivative = {
  id: string;
  photo_id: string;
  variant: string;
  storage_file_id: string;
  mime_type: string;
  width: number;
  height: number;
  file_size: number;
  status: DerivativeStatus;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
};

/**
 * Ensure one row per variant for a photo. Idempotent: re-enqueueing (retry,
 * duplicate upload callback, double kick) never creates a second row thanks
 * to the (photo_id, variant) unique index.
 */
export async function enqueuePhotoDerivatives(
  env: Env,
  photoId: string
): Promise<DbDerivative[]> {
  const pool = getPool(env);
  await pool.query(
    `INSERT INTO photo_derivatives (photo_id, variant, storage_file_id, mime_type, width, height, file_size)
     SELECT $1, v.variant, 'pending:' || gen_random_uuid()::text, 'image/webp', 1, 1, 0
     FROM (VALUES ('thumb_small'), ('thumb_large')) AS v(variant)
     ON CONFLICT (photo_id, variant) DO NOTHING`,
    [photoId]
  );
  const rows = await pool.query<DbDerivative>(
    "SELECT * FROM photo_derivatives WHERE photo_id = $1 ORDER BY variant ASC",
    [photoId]
  );
  return rows.rows;
}

/** All derivative rows for one photo, variant-ordered. */
export async function getPhotoDerivatives(
  env: Env,
  photoId: string
): Promise<DbDerivative[]> {
  const result = await getPool(env).query<DbDerivative>(
    "SELECT * FROM photo_derivatives WHERE photo_id = $1 ORDER BY variant ASC",
    [photoId]
  );
  return result.rows;
}

/**
 * One query for many photos — photo lists must never fan out per photo.
 * Returns a map of photo_id → rows (missing key = no derivatives yet).
 */
export async function getDerivativesForPhotos(
  env: Env,
  photoIds: string[]
): Promise<Map<string, DbDerivative[]>> {
  const byPhoto = new Map<string, DbDerivative[]>();
  if (photoIds.length === 0) return byPhoto;
  const result = await getPool(env).query<DbDerivative>(
    `SELECT * FROM photo_derivatives
     WHERE photo_id = ANY($1::uuid[])
     ORDER BY photo_id ASC, variant ASC`,
    [photoIds]
  );
  for (const row of result.rows) {
    const list = byPhoto.get(row.photo_id) ?? [];
    list.push(row);
    byPhoto.set(row.photo_id, list);
  }
  return byPhoto;
}

/** A single derivative row — used by the public proxy's ?variant= gate. */
export async function getPhotoDerivative(
  env: Env,
  photoId: string,
  variant: string
): Promise<DbDerivative | null> {
  const result = await getPool(env).query<DbDerivative>(
    "SELECT * FROM photo_derivatives WHERE photo_id = $1 AND variant = $2",
    [photoId, variant]
  );
  return result.rows[0] ?? null;
}

export type PhotoProcessingStatus = "QUEUED" | "PROCESSING" | "READY" | "FAILED";

/**
 * Photo-level rollup: READY only when every expected variant is READY, so a
 * gallery photo is never presented as fully processed early. No rows yet
 * (legacy uploads) reads as QUEUED — explicitly pending, never "done".
 */
export function summarizeProcessingStatus(rows: DbDerivative[]): PhotoProcessingStatus {
  if (rows.length === 0) return "QUEUED";
  if (rows.every((r) => r.status === "READY")) return "READY";
  if (rows.some((r) => r.status === "PROCESSING")) return "PROCESSING";
  if (rows.some((r) => r.status === "QUEUED")) return "QUEUED";
  return "FAILED";
}

// ---------------------------------------------------------------------------
// Runner (in-process for Phase 2; queue-backed from Phase 3).
// ---------------------------------------------------------------------------

/**
 * Atomically claim the next batch: QUEUED rows plus FAILED rows with
 * attempts left, oldest first. The single UPDATE…RETURNING is the
 * mutual-exclusion point — two concurrent sweeps (or a future multi-worker
 * pool) can never claim the same row.
 */
async function claimDueDerivatives(env: Env, limit: number): Promise<DbDerivative[]> {
  const result = await getPool(env).query<DbDerivative>(
    `UPDATE photo_derivatives d SET status = 'PROCESSING', attempts = d.attempts + 1, updated_at = now()
     WHERE d.id IN (
       SELECT id FROM photo_derivatives
       WHERE status = 'QUEUED' OR (status = 'FAILED' AND attempts < $1)
       ORDER BY created_at ASC
       LIMIT $2
     )
     RETURNING *`,
    [MAX_DERIVATIVE_ATTEMPTS, limit]
  );
  return result.rows;
}

/**
 * Crash recovery: a PROCESSING row whose heartbeat went stale belongs to a
 * dead worker — requeue it without spending an attempt (the attempt was
 * counted at claim time; the work may never have started).
 */
export async function recoverStuckDerivatives(env: Env): Promise<number> {
  const result = await getPool(env).query(
    `UPDATE photo_derivatives
     SET status = 'QUEUED', updated_at = now()
     WHERE status = 'PROCESSING' AND updated_at < now() - make_interval(secs => $1)`,
    [STUCK_PROCESSING_MS / 1000]
  );
  return result.rowCount ?? 0;
}

async function markDerivativeReady(
  env: Env,
  id: string,
  input: { storageFileId: string; width: number; height: number; fileSize: number }
): Promise<void> {
  await getPool(env).query(
    `UPDATE photo_derivatives
     SET status = 'READY', storage_file_id = $2, mime_type = 'image/webp',
         width = $3, height = $4, file_size = $5, last_error = NULL, updated_at = now()
     WHERE id = $1`,
    [id, input.storageFileId, input.width, input.height, input.fileSize]
  );
}

async function markDerivativeFailed(env: Env, id: string, error: string): Promise<void> {
  await getPool(env).query(
    `UPDATE photo_derivatives
     SET status = 'FAILED', last_error = left($2, 500), updated_at = now()
     WHERE id = $1`,
    [id, error]
  );
}

/**
 * Transform one claimed derivative: sniff the real format (never trust the
 * upload MIME), enforce dimension/pixel guards, resize without enlarging,
 * encode WebP, store as a new Appwrite object, mark READY. Any throw marks
 * the row FAILED with a truncated message — the original photo row and its
 * binary are never touched.
 */
export async function processDerivative(
  env: Env,
  derivative: DbDerivative,
  photo: DbPhoto
): Promise<void> {
  const spec = DERIVATIVE_VARIANTS.find((v) => v.name === derivative.variant);
  if (!spec) {
    await markDerivativeFailed(env, derivative.id, `Unknown variant: ${derivative.variant}`);
    return;
  }
  try {
    const original = await readPhotoBytes(env, photo.storage_file_id);
    const probe = sharp(original, { limitInputPixels: MAX_IMAGE_PIXELS });
    const meta = await probe.metadata();
    if (!meta.format || !["jpeg", "png", "webp"].includes(meta.format)) {
      throw new Error(`Unsupported image content (detected: ${meta.format ?? "unknown"})`);
    }
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width <= 0 || height <= 0) throw new Error("Unreadable image dimensions");
    if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
      throw new Error(`Image too large (${width}x${height})`);
    }
    const out = await sharp(original, { limitInputPixels: MAX_IMAGE_PIXELS })
      .rotate()
      .resize({ width: spec.width, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    const stored = await uploadPhoto(
      env,
      out.data,
      "image/webp",
      `${photo.filename} (${derivative.variant})`
    );
    await markDerivativeReady(env, derivative.id, {
      storageFileId: stored.storageFileId,
      width: out.info.width,
      height: out.info.height,
      fileSize: out.data.byteLength,
    });
  } catch (err) {
    await markDerivativeFailed(env, derivative.id, (err as Error).message);
  }
}

/**
 * Claim one row by id for the queue worker: only QUEUED or FAILED-with-
 * budget rows are claimable. Returns null when another worker won the race
 * or the row is READY/terminal — the worker treats that as a skip.
 */
export async function claimDerivativeById(
  env: Env,
  id: string
): Promise<DbDerivative | null> {
  const result = await getPool(env).query<DbDerivative>(
    `UPDATE photo_derivatives
     SET status = 'PROCESSING', attempts = attempts + 1, updated_at = now()
     WHERE id = $1 AND (status = 'QUEUED' OR (status = 'FAILED' AND attempts < $2))
     RETURNING *`,
    [id, MAX_DERIVATIVE_ATTEMPTS]
  );
  return result.rows[0] ?? null;
}

export type DerivativeJobOutcome = {
  outcome: "ready" | "failed" | "skipped";
  photoId: string;
  variant: string;
};

/**
 * One BullMQ job: exactly one (photo, variant). Idempotent — READY rows and
 * lost races are skips, never duplicate work. Content failures land in FAILED
 * (visible, retryable via the reconciler or retry endpoint); only unexpected
 * throws (bugs, PG down mid-job) propagate for BullMQ's own retry/backoff.
 */
export async function processDerivativeJob(
  env: Env,
  input: { photoId: string; variant: string }
): Promise<DerivativeJobOutcome> {
  const done = (outcome: DerivativeJobOutcome["outcome"]): DerivativeJobOutcome => ({
    outcome,
    photoId: input.photoId,
    variant: input.variant,
  });
  let row = await getPhotoDerivative(env, input.photoId, input.variant);
  if (!row) {
    const ensured = await enqueuePhotoDerivatives(env, input.photoId);
    row = ensured.find((r) => r.variant === input.variant) ?? null;
    if (!row) throw new Error("Derivative row could not be ensured");
  }
  if (row.status === "READY") return done("skipped");
  const claimed = await claimDerivativeById(env, row.id);
  if (!claimed) return done("skipped");
  const photoRes = await getPool(env).query<DbPhoto>("SELECT * FROM photos WHERE id = $1", [
    input.photoId,
  ]);
  const photo = photoRes.rows[0];
  if (!photo) {
    await markDerivativeFailed(env, claimed.id, "Photo no longer exists");
    return done("failed");
  }
  await processDerivative(env, claimed, photo);
  const check = await getPhotoDerivative(env, input.photoId, input.variant);
  return done(check?.status === "READY" ? "ready" : "failed");
}

export type SweepSummary = { claimed: number; ready: number; failed: number; recovered: number };

/** Run recovery + claim/process batches until the queue is drained. */
export async function sweepDerivativeQueue(env: Env): Promise<SweepSummary> {
  const summary: SweepSummary = { claimed: 0, ready: 0, failed: 0, recovered: 0 };
  summary.recovered = await recoverStuckDerivatives(env);
  for (;;) {
    const batch = await claimDueDerivatives(env, SWEEP_BATCH);
    if (batch.length === 0) break;
    summary.claimed += batch.length;
    for (const derivative of batch) {
      const photoRes = await getPool(env).query<DbPhoto>(
        "SELECT * FROM photos WHERE id = $1",
        [derivative.photo_id]
      );
      const photo = photoRes.rows[0];
      if (!photo) {
        // Photo deleted mid-flight — fail the row so it stops being claimed.
        await markDerivativeFailed(env, derivative.id, "Photo no longer exists");
        summary.failed += 1;
        continue;
      }
      await processDerivative(env, derivative, photo);
      const check = await getPhotoDerivative(env, derivative.photo_id, derivative.variant);
      if (check?.status === "READY") summary.ready += 1;
      else summary.failed += 1;
    }
  }
  return summary;
}

let sweepRunning = false;

/**
 * Fire-and-forget trigger for HTTP handlers: returns immediately so uploads
 * never wait for sharp/Appwrite, and concurrent triggers collapse into the
 * in-flight sweep. Errors go to the server log — row state stays truthful.
 */
export function kickDerivativeWorker(env: Env): void {
  if (sweepRunning) return;
  sweepRunning = true;
  void sweepDerivativeQueue(env)
    .catch((err) => console.error("Derivative sweep failed:", (err as Error).message))
    .finally(() => {
      sweepRunning = false;
    });
}

/**
 * Explicit admin recovery: ensure rows exist, reset FAILED rows to QUEUED
 * with a fresh attempt budget, and trigger a sweep. READY rows are kept —
 * never reprocessed.
 */
export async function requeuePhotoDerivatives(
  env: Env,
  photoId: string
): Promise<DbDerivative[]> {
  await enqueuePhotoDerivatives(env, photoId);
  await getPool(env).query(
    `UPDATE photo_derivatives
     SET status = 'QUEUED', attempts = 0, last_error = NULL, updated_at = now()
     WHERE photo_id = $1 AND status = 'FAILED'`,
    [photoId]
  );
  kickDerivativeWorker(env);
  return getPhotoDerivatives(env, photoId);
}
