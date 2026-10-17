import type { NextFunction, Request, Response } from "express";

import { httpRequestDuration, httpRequestsTotal } from "../lib/metrics.js";

// ---------------------------------------------------------------------------
// HTTP metrics (Phase 9). Count + duration per request, labelled by method,
// status, and the Express route PATTERN — never the raw URL. Parametrized
// routes therefore contribute one bounded series each; unmatched requests
// (404s) collapse into route="unmatched".
// ---------------------------------------------------------------------------

/**
 * The route label for a request: the matched Express route pattern with its
 * mount prefix, or "unmatched" when no route matched (e.g. 404s). Express
 * sets `req.route` only after a route matches, so this must run at
 * response-finish time, not middleware-entry time.
 */
export function normalizedRoute(req: Pick<Request, "baseUrl" | "route">): string {
  const pattern = req.route?.path;
  if (typeof pattern !== "string") return "unmatched";
  const full = `${req.baseUrl ?? ""}${pattern}`;
  return full === "" ? "/" : full;
}

export function httpMetricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const started = process.hrtime.bigint();
  res.on("finish", () => {
    const route = normalizedRoute(req);
    const labels = { method: req.method, route };
    httpRequestsTotal.inc({ ...labels, status: String(res.statusCode) });
    httpRequestDuration.observe(labels, Number(process.hrtime.bigint() - started) / 1e9);
  });
  next();
}
