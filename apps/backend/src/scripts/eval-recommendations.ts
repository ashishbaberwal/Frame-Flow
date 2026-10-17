import { readFileSync } from "node:fs";

import { evaluateRecoDataset, parseRecoDataset } from "../lib/reco-eval.js";

/**
 * `bun run eval:reco` — offline scorecard for the deterministic
 * recommendation baseline (Phase 10).
 *
 * Loads eval/reco-dataset.json, runs the same pure scorer production
 * uses, checks golden orderings and precision@k against the held-out
 * picks, prints a per-case table, and exits non-zero when any case
 * regresses. No database, no network, no clock — a laptop or CI can
 * reproduce the exact scorecard.
 */

const datasetPath = new URL("../../eval/reco-dataset.json", import.meta.url);
const dataset = parseRecoDataset(JSON.parse(readFileSync(datasetPath, "utf8")));
const report = evaluateRecoDataset(dataset);

const lines: string[] = [];
lines.push(`Recommendation evaluation — ${report.strategy}`);
lines.push(`dataset: ${report.datasetName} (min precision@k: ${report.minPrecision})`);
for (const c of report.cases) {
  const precision = c.precisionAtK === null ? "n/a" : c.precisionAtK.toFixed(3);
  lines.push(
    `${c.passed ? "PASS" : "FAIL"}  ${c.id.padEnd(26)} golden=${c.goldenMatch ? "match" : "MISMATCH"}  precision@${c.k}=${precision}`
  );
  if (!c.goldenMatch) {
    lines.push(`      expected: ${c.expectedTop.join(", ")}`);
    lines.push(`      actual:   ${c.actualTop.join(", ")}`);
  }
}
lines.push(`Overall: ${report.passed ? "PASS" : "FAIL"}`);
process.stdout.write(lines.join("\n") + "\n");
process.exit(report.passed ? 0 : 1);
