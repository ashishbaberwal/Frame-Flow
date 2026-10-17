import type { NextFunction, Request, RequestHandler, Response } from "express";

import type { RateLimitClass, RateLimiter } from "../lib/rate-limit.js";

// ---------------------------------------------------------------------------
// Express adapter for the distributed limiter (Phase 7).
//
// One middleware factory, one decision per request: consume() is atomic and
// never throws (the limiter owns Redis failure policy), so this middleware
// can only ever pass through or answer 429 — never 500.
// ---------------------------------------------------------------------------

export type RateLimitMiddlewareOptions = {
  limiter: RateLimiter;
  cls: RateLimitClass;
  /**
   * Bucket material for this request, or null to skip limiting entirely
   * (e.g. a route where no stable identity exists yet). Callers build this
   * from trusted server-side values only — req.ip (trust proxy is
   * configured in server.ts) and verified req.auth identity.
   */
  key: (req: Request) => string | null;
  errorMessage?: string;
};

function log(event: string, detail: string): void {
  console.log(JSON.stringify({ scope: "rate-limit", event, detail }));
}

export function createRateLimitMiddleware(options: RateLimitMiddlewareOptions): RequestHandler {
  const { limiter, cls, key } = options;
  const message = options.errorMessage ?? "Too many requests. Please try again shortly.";
  return (req: Request, res: Response, next: NextFunction) => {
    const material = key(req);
    if (!material) {
      next();
      return;
    }
    void limiter
      .consume(cls, material)
      .then((decision) => {
        if (decision.allowed) {
          next();
          return;
        }
        const retryAfterSeconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
        // Structured log WITHOUT the bucket material — class and wait only.
        log("blocked", `${cls} retry-after=${retryAfterSeconds}s`);
        res.set("Retry-After", String(retryAfterSeconds));
        res.status(429).json({ error: message });
      })
      // consume() never rejects; this belt-and-braces guard keeps a bug from
      // turning into a 500 on every request path.
      .catch((err: unknown) => {
        log("error", (err as Error).message);
        next();
      });
  };
}
