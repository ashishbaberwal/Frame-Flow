import { z } from "zod";

import {
  RECO_STRATEGY,
  scorePhotoRecommendations,
  type RecommendationSignals,
} from "./recommendations.js";

/**
 * Phase 10 — offline evaluation harness for the deterministic
 * recommendation baseline.
 *
 * "Deterministic" is only a virtue if it is verifiable: this module loads
 * a fixed synthetic dataset (eval/reco-dataset.json), runs the exact same
 * pure scorer that serves production, and checks two things per case:
 *
 * 1. Golden ordering — the top-N photo ids must match the dataset exactly.
 *    Any drift in the scorer, the tie-break, or the burst window fails
 *    loudly instead of silently reordering suggestions.
 * 2. Held-out precision@k — the dataset carries the picks an admin would
 *    plausibly make ("holdout_picks"); precision is the share of the
 *    ranker's top-k that is actually in that set. This is the closest
 *    honest analogue to a relevance metric without real usage data — no
 *    ML claims are made or implied.
 *
 * `bun run eval:reco` runs this from the CLI (tests also pin it in CI).
 */

/**
 * Minimum precision@k per case before the dataset fails. Calibrated
 * against the committed dataset (actual: 0.833) — deliberately below the
 * observed value so the check is a regression guard, not a tautology.
 */
export const RECO_EVAL_MIN_PRECISION = 0.75;

const signalSchema = z.object({
  photo_id: z.string().min(1).max(64),
  uploaded_by: z.string().min(1).max(64),
  uploaded_at: z
    .string()
    .min(1)
    .refine((s) => !Number.isNaN(Date.parse(s)), "uploaded_at must be an ISO timestamp"),
  views: z.number().int().min(0),
  downloads: z.number().int().min(0),
  pinned: z.boolean(),
});

const caseSchema = z.object({
  id: z.string().min(1).max(64),
  description: z.string().min(1).max(500),
  signals: z.array(signalSchema).min(1).max(1000),
  expected_top: z.array(z.string().min(1).max(64)).min(1),
  holdout_picks: z.array(z.string().min(1).max(64)).default([]),
});

const datasetSchema = z.object({
  name: z.string().min(1).max(120),
  version: z.number().int().min(1),
  description: z.string().min(1).max(1000),
  cases: z.array(caseSchema).min(1),
});

export type RecoDatasetCase = z.infer<typeof caseSchema>;
export type RecoDataset = z.infer<typeof datasetSchema>;

export function parseRecoDataset(input: unknown): RecoDataset {
  return datasetSchema.parse(input);
}

export interface CaseEvaluation {
  id: string;
  passed: boolean;
  /** Top-N ids equal the dataset's expected_top (N = expected_top.length). */
  goldenMatch: boolean;
  actualTop: string[];
  expectedTop: string[];
  /** Share of the ranker's top-k in holdout_picks; null without a holdout. */
  precisionAtK: number | null;
  k: number;
}

export interface RecoEvaluationReport {
  datasetName: string;
  strategy: string;
  minPrecision: number;
  cases: CaseEvaluation[];
  passed: boolean;
}

function toSignals(recoCase: RecoDatasetCase): RecommendationSignals[] {
  return recoCase.signals.map((s) => ({
    photoId: s.photo_id,
    uploadedBy: s.uploaded_by,
    uploadedAt: s.uploaded_at,
    views: s.views,
    downloads: s.downloads,
    pinned: s.pinned,
  }));
}

export function evaluateRecoDataset(dataset: RecoDataset): RecoEvaluationReport {
  const cases = dataset.cases.map((recoCase): CaseEvaluation => {
    const scored = scorePhotoRecommendations(toSignals(recoCase));
    const rankedIds = scored.map((s) => s.photoId);
    const goldenK = recoCase.expected_top.length;
    const actualTop = rankedIds.slice(0, goldenK);
    const goldenMatch =
      actualTop.length === goldenK &&
      actualTop.every((id, i) => id === recoCase.expected_top[i]);

    const k = recoCase.holdout_picks.length;
    let precisionAtK: number | null = null;
    if (k > 0) {
      const holdout = new Set(recoCase.holdout_picks);
      const hits = rankedIds.slice(0, k).filter((id) => holdout.has(id)).length;
      precisionAtK = hits / k;
    }

    return {
      id: recoCase.id,
      passed: goldenMatch && (precisionAtK === null || precisionAtK >= RECO_EVAL_MIN_PRECISION),
      goldenMatch,
      actualTop,
      expectedTop: recoCase.expected_top,
      precisionAtK,
      k,
    };
  });

  return {
    datasetName: dataset.name,
    strategy: RECO_STRATEGY,
    minPrecision: RECO_EVAL_MIN_PRECISION,
    cases,
    passed: cases.every((c) => c.passed),
  };
}
