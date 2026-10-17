import type { Env } from "../config/env.js";
import {
  getPhotoPopularity,
  listCurationPickIds,
  listEventPhotoCandidates,
  type DbPhoto,
} from "./db.js";

/**
 * Phase 10 — deterministic recommendation baseline.
 *
 * The recommender answers ONE curation question for admins: "which photos
 * from this event should I look at first when building a gallery?" It is a
 * pure, reproducible ranking — no machine learning, no per-visitor
 * personalization, no hidden state. Every ordering decision can be
 * recomputed from Postgres alone:
 *
 *   score = admin pick (1000)
 *         + recent popularity (views + 2 x downloads, 30-day window, capped)
 *         + capture-burst affinity (same-uploader photos within 2 minutes)
 *   tie-break = newest upload first, then photo id ascending
 *
 * Signal mapping to the plan's vocabulary (the platform has no photo tags,
 * so "same-category" resolves to the event itself — the candidates are
 * always photos of the same event):
 *
 * - same-category/tag  -> the event scope: every candidate belongs to the
 *   requested event; nothing outside it is ever considered.
 * - recent-popular     -> eligible PhotoViewed / PhotoDownloaded counts
 *   from analytics_event_log over RECO_POPULARITY_WINDOW_DAYS. Bot-class
 *   events are filtered out at read time, exactly like the Phase 8
 *   popular-galleries ranking.
 * - content-similarity -> deterministic capture-burst affinity: a member
 *   uploading 3+ photos within 2 minutes was shooting one scene, so those
 *   photos surface together. This is a metadata proxy — no image content
 *   is analysed (that would be ML and is deliberately out of scope).
 * - admin picks        -> curation_picks rows (workspace-scoped, written
 *   through the photo-picks endpoints). The strongest signal: always ranks
 *   above every heuristic.
 * - cold-start fallback-> when a photo has no positive signal at all the
 *   reason is "recent" and recency decides the order. A brand-new event
 *   is therefore ranked newest-first, deterministically.
 *
 * Private-galleries-never-public rule: this module is only reachable
 * through ADMIN endpoints scoped to the caller's workspace, and its output
 * is photos only — never gallery ids, slugs, PINs or status. Gallery
 * visibility cannot leak through a recommendation.
 *
 * Evaluation: eval/reco-dataset.json + src/lib/reco-eval.ts hold a fixed,
 * synthetic dataset with golden orderings and a held-out-picks precision
 * check, run by `bun run eval:reco`. Deterministic means testable, so the
 * baseline ships with an offline scorecard — required before anyone may
 * claim "recommendations work".
 */

export const RECO_STRATEGY = "deterministic-baseline-v1";

/** Popularity window (days) for PhotoViewed/PhotoDownloaded counts. */
export const RECO_POPULARITY_WINDOW_DAYS = 30;
/** Candidate cap: score at most this many photos per request (bounded work). */
export const RECO_CANDIDATE_CAP = 1000;
export const RECO_DEFAULT_LIMIT = 24;
export const RECO_MAX_LIMIT = 50;

/**
 * Capture-burst affinity: photos from the same uploader within this many
 * seconds of each other count as neighbours. A photo with at least this
 * many neighbours is part of a burst (3+ photos total).
 */
export const RECO_BURST_WINDOW_SECONDS = 120;
export const RECO_BURST_MIN_NEIGHBORS = 2;
/** Neighbour count is capped before weighting, so one huge burst cannot
 * dominate the ranking. */
export const RECO_BURST_MAX_NEIGHBORS = 5;
export const RECO_BURST_WEIGHT = 8;

/** Popularity contribution is capped well below the pin weight. */
export const RECO_POPULARITY_CAP = 200;
/**
 * Admin picks dominate every heuristic: 1000 > max heuristic score
 * (200 popularity + 40 burst = 240), so a pick always sorts first.
 */
export const RECO_PIN_WEIGHT = 1000;

export type RecoReason = "admin_pick" | "popular" | "same_burst" | "recent";

/** Everything the scorer needs for one candidate photo. */
export interface RecommendationSignals {
  photoId: string;
  uploadedBy: string;
  /** ISO-8601 upload timestamp. */
  uploadedAt: string;
  /** Eligible (non-bot) PhotoViewed count in the popularity window. */
  views: number;
  /** Eligible (non-bot) PhotoDownloaded count in the popularity window. */
  downloads: number;
  /** Workspace admin pick (curation_picks row). */
  pinned: boolean;
}

export interface ScoredRecommendation {
  photoId: string;
  score: number;
  reasons: RecoReason[];
}

function popularityScore(views: number, downloads: number): number {
  const eligibleViews = Math.max(0, views);
  const eligibleDownloads = Math.max(0, downloads);
  return Math.min(eligibleViews + 2 * eligibleDownloads, RECO_POPULARITY_CAP);
}

/**
 * Pure, deterministic ranking of candidate photos. Given identical inputs
 * the output order is byte-identical on every call and every machine —
 * no clock reads, no randomness, no environment sensitivity.
 */
export function scorePhotoRecommendations(
  signals: readonly RecommendationSignals[]
): ScoredRecommendation[] {
  if (signals.length === 0) return [];

  // Capture-burst neighbours: same uploader, upload times within the
  // window (either direction). O(group^2) per uploader, bounded by the
  // candidate cap.
  const byUploader = new Map<string, number[]>();
  signals.forEach((s, i) => {
    const group = byUploader.get(s.uploadedBy);
    if (group) group.push(i);
    else byUploader.set(s.uploadedBy, [i]);
  });
  const neighbors = new Array<number>(signals.length).fill(0);
  const windowMs = RECO_BURST_WINDOW_SECONDS * 1000;
  for (const group of byUploader.values()) {
    for (let a = 0; a < group.length; a += 1) {
      for (let b = a + 1; b < group.length; b += 1) {
        const ia = group[a]!;
        const ib = group[b]!;
        const delta = Math.abs(
          Date.parse(signals[ia]!.uploadedAt) - Date.parse(signals[ib]!.uploadedAt)
        );
        if (delta <= windowMs) {
          neighbors[ia] += 1;
          neighbors[ib] += 1;
        }
      }
    }
  }

  const scored = signals.map((s, i) => {
    const popularity = popularityScore(s.views, s.downloads);
    const burst =
      neighbors[i]! >= RECO_BURST_MIN_NEIGHBORS
        ? Math.min(neighbors[i]!, RECO_BURST_MAX_NEIGHBORS) * RECO_BURST_WEIGHT
        : 0;
    const score = (s.pinned ? RECO_PIN_WEIGHT : 0) + popularity + burst;

    const reasons: RecoReason[] = [];
    if (s.pinned) reasons.push("admin_pick");
    if (popularity > 0) reasons.push("popular");
    if (burst > 0) reasons.push("same_burst");
    // Cold start: no human, popularity or burst signal — recency is the
    // only thing left, and that is exactly what the tie-break already does.
    if (reasons.length === 0) reasons.push("recent");

    return { photoId: s.photoId, score, reasons, uploadedAt: s.uploadedAt };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const at = Date.parse(a.uploadedAt);
    const bt = Date.parse(b.uploadedAt);
    if (bt !== at) return bt - at; // newest first
    // Full determinism: byte-order id comparison, never locale-sensitive.
    if (a.photoId !== b.photoId) return a.photoId < b.photoId ? -1 : 1;
    return 0;
  });

  return scored.map(({ photoId, score, reasons }) => ({ photoId, score, reasons }));
}

export interface PhotoRecommendation {
  photo: DbPhoto;
  score: number;
  reasons: RecoReason[];
}

/**
 * Orchestrator: assemble signals from Postgres (candidates, popularity,
 * picks), run the pure scorer, return the top `limit` photos with their
 * full metadata. Three bounded queries total — candidate list, popularity
 * aggregate, pick set — never a per-photo fan-out.
 */
export async function getPhotoRecommendations(
  env: Env,
  input: { workspaceId: string; eventId: string; limit: number }
): Promise<{ candidates: number; recommendations: PhotoRecommendation[] }> {
  const candidates = await listEventPhotoCandidates(env, input.eventId, RECO_CANDIDATE_CAP);
  if (candidates.length === 0) {
    return { candidates: 0, recommendations: [] };
  }
  const photoIds = candidates.map((c) => c.id);
  const [popularity, pinned] = await Promise.all([
    getPhotoPopularity(env, input.workspaceId, photoIds, RECO_POPULARITY_WINDOW_DAYS),
    listCurationPickIds(env, input.workspaceId, photoIds),
  ]);

  const scored = scorePhotoRecommendations(
    candidates.map((c) => ({
      photoId: c.id,
      uploadedBy: c.uploaded_by,
      uploadedAt: c.created_at.toISOString(),
      views: popularity.get(c.id)?.views ?? 0,
      downloads: popularity.get(c.id)?.downloads ?? 0,
      pinned: pinned.has(c.id),
    }))
  );

  const byId = new Map(candidates.map((c) => [c.id, c]));
  return {
    candidates: candidates.length,
    recommendations: scored.slice(0, input.limit).map((s) => ({
      photo: byId.get(s.photoId)!,
      score: s.score,
      reasons: s.reasons,
    })),
  };
}
