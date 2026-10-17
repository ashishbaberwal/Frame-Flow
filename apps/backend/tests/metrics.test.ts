import express from "express";
import { describe, expect, it } from "vitest";
import request from "supertest";

import type { Env } from "../src/config/env.js";
import { resetEnvCache } from "../src/config/env.js";
import {
  metricsEnabled,
  metricsRegistry,
  resetMetricsForTests,
  verifyMetricsToken,
} from "../src/lib/metrics.js";
import { httpMetricsMiddleware, normalizedRoute } from "../src/middleware/metrics.js";
import { createApp } from "../src/server.js";

// ---------------------------------------------------------------------------
// Phase 9 — metrics surface.
//
// Covers: exposure gating (off by default, and off in tests unless opted
// in), bearer token enforcement, default + custom metrics presence, and the
// label-cardinality guard — parametrized routes must collapse into their
// route PATTERN, with no raw ids anywhere in the scrape output.
// ---------------------------------------------------------------------------

function buildApp(options: { metrics?: boolean; token?: string } = {}) {
  process.env.NODE_ENV = "test";
  process.env.PORT = process.env.PORT && process.env.PORT !== "0" ? process.env.PORT : "4000";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://test:test@localhost:5432/test";
  process.env.CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY ?? "sk_test_placeholder";
  process.env.APPWRITE_ENDPOINT =
    process.env.APPWRITE_ENDPOINT ?? "https://cloud.appwrite.io/v1";
  process.env.APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID ?? "test-project";
  process.env.APPWRITE_API_KEY = process.env.APPWRITE_API_KEY ?? "test-key";
  process.env.APPWRITE_BUCKET_ID = process.env.APPWRITE_BUCKET_ID ?? "test-bucket";
  if (options.metrics) process.env.METRICS_ENABLED = "true";
  else delete process.env.METRICS_ENABLED;
  if (options.token) process.env.METRICS_TOKEN = options.token;
  else delete process.env.METRICS_TOKEN;
  resetEnvCache();
  return createApp();
}

describe("metrics exposure policy", () => {
  it("stays off in tests unless METRICS_ENABLED=true", async () => {
    const res = await request(buildApp()).get("/metrics");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not found" });
  });

  it("serves Prometheus text when enabled, including default and custom metrics", async () => {
    const app = buildApp({ metrics: true });
    await request(app).get("/health").expect(200);
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    // Default process metrics.
    expect(res.text).toContain("process_resident_memory_bytes");
    // Our HTTP metrics, with the earlier /health request counted.
    expect(res.text).toContain("# HELP frameflow_http_requests_total");
    expect(res.text).toContain('route="/health"');
    expect(res.text).toContain("frameflow_http_request_duration_seconds_bucket");
  });

  it("enforces the bearer token when METRICS_TOKEN is set", async () => {
    const app = buildApp({ metrics: true, token: "metrics-token-0123456789" });
    const denied = await request(app).get("/metrics");
    expect(denied.status).toBe(401);
    expect(denied.body).toEqual({ error: "Unauthorized" });

    const wrong = await request(app)
      .get("/metrics")
      .set("Authorization", "Bearer not-the-token");
    expect(wrong.status).toBe(401);

    const allowed = await request(app)
      .get("/metrics")
      .set("Authorization", "Bearer metrics-token-0123456789");
    expect(allowed.status).toBe(200);
  });

  it("answers non-GET methods with 401/404 consistently (never leaks on 404 path)", async () => {
    // Without a token the endpoint is open to GET; other methods fall
    // through Express routing (no POST route) → 404 from the catch-all.
    const app = buildApp({ metrics: true });
    const res = await request(app).post("/metrics");
    expect(res.status).toBe(404);
  });
});

describe("metricsEnabled", () => {
  it("defaults on in development, off elsewhere, overridable both ways", () => {
    expect(metricsEnabled({ NODE_ENV: "development" } as Env)).toBe(true);
    expect(metricsEnabled({ NODE_ENV: "test" } as Env)).toBe(false);
    expect(metricsEnabled({ NODE_ENV: "production" } as Env)).toBe(false);
    expect(metricsEnabled({ NODE_ENV: "production", METRICS_ENABLED: "true" } as Env)).toBe(true);
    expect(metricsEnabled({ NODE_ENV: "development", METRICS_ENABLED: "false" } as Env)).toBe(
      false
    );
  });
});

describe("verifyMetricsToken", () => {
  it("accepts only the exact bearer token", () => {
    expect(verifyMetricsToken("Bearer secret-token-123456", "secret-token-123456")).toBe(true);
    expect(verifyMetricsToken("Bearer wrong", "secret-token-123456")).toBe(false);
    expect(verifyMetricsToken("secret-token-123456", "secret-token-123456")).toBe(false);
    expect(verifyMetricsToken(undefined, "secret-token-123456")).toBe(false);
  });
});

describe("normalizedRoute", () => {
  type RouteRequest = Parameters<typeof normalizedRoute>[0];

  it("uses the matched route pattern with its mount prefix", () => {
    expect(
      normalizedRoute({ baseUrl: "", route: { path: "/health" } } as unknown as RouteRequest)
    ).toBe("/health");
    expect(
      normalizedRoute({
        baseUrl: "/api/v1",
        route: { path: "/events/:id/photos" },
      } as unknown as RouteRequest)
    ).toBe("/api/v1/events/:id/photos");
  });

  it("collapses unmatched requests and never returns a raw URL", () => {
    expect(normalizedRoute({ baseUrl: "", route: undefined } as unknown as RouteRequest)).toBe(
      "unmatched"
    );
    // A raw path that happened to be set is not consulted.
    const raw = normalizedRoute({
      baseUrl: "/api/v1",
      route: undefined,
      path: "/public/galleries/secret-slug",
    } as unknown as RouteRequest);
    expect(raw).toBe("unmatched");
  });
});

describe("route label cardinality guard", () => {
  it("collapses many parameter values into one series and keeps ids out of the output", async () => {
    const app = express();
    app.use(httpMetricsMiddleware);
    app.get("/items/:id", (_req, res) => {
      res.json({ ok: true });
    });

    resetMetricsForTests();
    const firstId = "11111111-1111-4111-8111-111111111111";
    const secondId = "22222222-2222-4222-8222-222222222222";
    await request(app).get(`/items/${firstId}`).expect(200);
    await request(app).get(`/items/${secondId}`).expect(200);
    await request(app).get("/definitely-not-a-route").expect(404);

    const body = await metricsRegistry.metrics();
    // Exactly one series for the parametrized route, counting both requests.
    expect(body).toContain(
      'frameflow_http_requests_total{method="GET",route="/items/:id",status="200"} 2'
    );
    // Unmatched requests collapse into one bounded series.
    expect(body).toContain(
      'frameflow_http_requests_total{method="GET",route="unmatched",status="404"} 1'
    );
    // No raw parameter values (or URL fragments) leaked into labels.
    expect(body).not.toContain(firstId);
    expect(body).not.toContain(secondId);
    expect(body).not.toContain("definitely-not-a-route");
  });
});
