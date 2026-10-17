import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

// ---------------------------------------------------------------------------
// Request correlation (Phase 9). Every request gets an id — inbound
// X-Request-Id when it looks sane (bounded charset/length so header abuse
// can't inject junk), else a fresh UUID — echoed on the response and logged
// by the error handler. Never used for authorization decisions.
// ---------------------------------------------------------------------------

declare global {
  namespace Express {
    interface Request {
      id?: string;
    }
  }
}

export const REQUEST_ID_HEADER = "x-request-id";

const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.headers[REQUEST_ID_HEADER];
  const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
  const id = candidate && VALID_REQUEST_ID.test(candidate) ? candidate : randomUUID();
  req.id = id;
  res.setHeader("X-Request-Id", id);
  next();
}
