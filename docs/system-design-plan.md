# FrameFlow System-Design Upgrades — Phase 0 Audit & Implementation Plan

Status: Phase 0 only. No application code changed in this commit.
Branch: `feat/system-design-upgrades`
Date: 2026-10-10

This document is the Phase 0 deliverable required by the master prompt:
audit the real repository state from source, verify each claimed limitation
in code, then plan Phases 1–10 as small, test-driven, reversible increments.

Remote note: the prompt names `https://github.com/ashishbaberwal/Frame-Flow`;
the checked-out remote is `https://github.com/ashishbaberwal/trizen-ai.git`
(`git remote -v`). All findings below come from the latter tree.

---

## 1. Current architecture (verified in code)

```text
Browser → Next.js :3000 → Express :4000
                        ├── Clerk (@clerk/backend verifyToken) → identity
                        ├── Supabase PostgreSQL via pg → metadata only
                        └── Appwrite Storage via node-appwrite → photo bytes only
```

- Monorepo: Turborepo + Bun workspaces (`package.json`, `turbo.json`,
  `bun.lock` at root). Frontend `apps/frontend` (Next.js 16, React 19),
  backend `apps/backend` (Express 5 + TypeScript, ESM `"type": "module"`).
- All application APIs under `/api/v1` (`apps/backend/src/routes/api.ts`,
  mounted in `src/server.ts`). Errors are `{ "error": "..." }`
  (`src/middleware/error.ts`).
- Auth: `Authorization: Bearer <Clerk session>` → `requireAuth`
  (`src/middleware/auth.ts`) → `verifyToken` + best-effort
  `users.getUser(sub)` profile fetch → `resolveAppUser` JIT-provisions via
  `upsertUserFromClerk` (`src/lib/db.ts`). Roles come from Postgres
  (`requireRole`), never the client.
- Env is validated at boot and refuses to start misconfigured
  (`src/config/env.ts`); TLS verified with `DATABASE_SSL_CA` in production
  (`src/lib/db.ts`).

### 1.1 Authenticated upload flow (traced)

1. Frontend `uploadPhotos` XHR `POST {API}/api/v1/events/:eventId/photos`
   with Clerk token (`apps/frontend/src/lib/api/client.ts`).
2. `server.ts`: helmet → cors → compression → `express.json` →
   `/api/v1` auth gate → router.
3. `POST /events/:eventId/photos` (`api.ts:452-505`):
   `authorizeEventAccess` (workspace gate via `getWorkspaceEvent` +
   `isEventMember`) → multer memory storage (20 files × 25 MB,
   `src/middleware/upload.ts`) → sequential per-file loop:
   `uploadPhoto` to Appwrite (`src/lib/storage.ts`, `randomUUID` key) →
   `insertPhoto` metadata (`src/lib/db.ts`) with `uploaded_by` from the
   verified user; Appwrite object deleted if the metadata insert fails.
4. Response serializes direct Appwrite view/download URLs (`photoUrl`,
   `photoDownloadUrl`) for the signed-in dashboard.

### 1.2 Public gallery flow (traced)

1. `GET /api/v1/public/galleries/:slug` (`api.ts:765-773`): published-only
   metadata (`getPublishedGalleryBySlug`; drafts 404 identically).
2. `POST /api/v1/public/galleries/:slug/unlock { pin }` (`api.ts:780-817`):
   zod 6-digit check → in-memory `isRateLimited(slug:ip)` → fetch published
   gallery → `timingSafeEqual` PIN compare → `clearFailures` on success →
   `listGalleryPhotos` (full set) → mint HMAC `${expiresAt}.${mac}` token
   bound to slug, 12 h TTL (`src/lib/gallery-tokens.ts`) → return photos
   with backend-relative proxied URLs.
3. `GET /api/v1/public/galleries/:slug/photos/:photoId?st=` (`api.ts:825-866`):
   verify token → published check → `getPhotoById` →
   `isPhotoInGallery` single `EXISTS`-style query → `readPhotoBytes` from
   Appwrite → stream with `Content-Type`/`Content-Disposition`, `CORP:
   cross-origin` scoped to this route.
4. Customer page (`apps/frontend/src/app/gallery/[slug]/page.tsx`) uses only
   these three endpoints via `getPublicGallery`/`unlockGallery`; no Clerk
   token, no direct Appwrite URLs.

---

## 2. What exists vs what is missing

Existing (do not rebuild): Clerk auth + JIT provisioning, workspace
isolation, event CRUD + assignment, photo upload/read-own/admin-full,
gallery create/publish/custom-PIN/regenerate, PIN unlock + signed proxy,
dashboard stats/activity, team management, `GET /health` +
`GET /api/v1/health`, Dockerized backend, Vercel frontend, CI
(lint/type/test/build on `postgres:16`).

Verified missing for Phases 1–10 (grep + code read, Oct 2026):

| Capability | Evidence of absence |
|---|---|
| Pagination | `listEventPhotos` (`db.ts:273-294`) and `listGalleryPhotos` (`db.ts:391-401`) are unbounded `SELECT … ORDER BY` with no `LIMIT/OFFSET/cursor`; routes `GET /events/:eventId/photos` (`api.ts:507-516`) and `POST …/unlock` (`api.ts:805`) return full arrays; only `LIMIT` in the codebase is dashboard activity `limit = 8` (`db.ts:919`) |
| Thumbnails / derivatives | No `sharp`/`thumbnail`/`derivative`/`processing_status` in `apps/backend/{src,package.json}` or migrations; grid renders full originals |
| Queue / workers | No `bullmq`/`ioredis`, no worker entrypoint, no `queue` module; upload handler does Appwrite I/O inline |
| Analytics / Kafka | No `kafkajs`/`kafka`, no event contract, no consumer, no analytics tables; `stats` endpoint is operational counts only |
| Distributed rate limit | `src/lib/rate-limit.ts` is a process-local `Map` (header comment says "Single-process only") |
| Metrics / dashboards | No `prom-client`/`prometheus`, no `/metrics`, no Grafana files |
| Recommendations | Nothing beyond gallery CRUD |

Backend deps today (`apps/backend/package.json`): `@clerk/backend`,
`compression`, `cors`, `dotenv`, `express`, `helmet`, `multer`,
`node-appwrite`, `pg`, `zod` (+ dev: `vitest`, `supertest`, `tsx`,
`typescript`, `eslint`). No Redis/Kafka/metrics/image libraries.

---

## 3. Database and storage design

Migrations (`supabase/migrations/`, applied in filename order, also by CI
with `psql`): `foundation_users` (users + `user_role` enum + RLS, no anon
policies) → `events_and_team` (events, `event_team_members`) →
`multi_tenant_workspaces` (workspaces, `users.workspace_id NOT NULL`,
`events.workspace_id NOT NULL`, invitations) → `photos` (metadata only,
`storage_file_id UNIQUE`, `idx_photos_event (event_id, created_at desc)`) →
`galleries` (galleries + `gallery_photos`, slug `UNIQUE`, status check).

- Tenancy boundary is `workspaces.id`; `photos`/`galleries` resolve through
  `events.workspace_id`. RLS enabled, no anon policies; backend uses the
  privileged connection (`src/lib/db.ts` pool, `max: 10`).
- Photos table stores metadata only (event, uploader, filename,
  `storage_file_id`, MIME, size). Binaries live in Appwrite bucket `photos`.
- No analytics, derivative, outbox, or job tables exist yet. No destructive
  migration is planned; every future migration must be additive first with a
  compatibility window (especially PIN hashing, Phase 7-adjacent).

---

## 4. Deployment constraints (do not break)

- Frontend on Vercel (`apps/frontend`, no Dockerfile by design);
  `NEXT_PUBLIC_*` baked at build time; `proxy.ts` (not `middleware.ts`)
  with Clerk Core 3 `<Show>`.
- Backend on Render as Docker (build context = repo root:
  `docker build -f apps/backend/Dockerfile -t frameflow-backend .`);
  image notes that must hold: keep `"type": "module"` (ESM output),
  copy both Bun halves (`/app/node_modules` + `apps/backend/node_modules`),
  ship `prod-ca-2021.crt`, runtime deps only, non-root `app` user,
  `HEALTHCHECK` on `/health`, exec-form `CMD`, bind `0.0.0.0:$PORT`.
- Managed services stay external: Clerk (auth), Supabase Postgres
  (transaction-pooler `DATABASE_URL` + CA), Appwrite Storage (server API key
  with storage-only scopes). Never containerize them.
- No Redis/Kafka/metrics infrastructure exists on Vercel or Render today.
  Local dev will use Docker Compose for Redis + Kafka + Prometheus/Grafana;
  production needs explicit human-approved managed services (e.g. Upstash
  Redis, Confluent/Redpanda/Aiven Kafka) — not in this commit, decided per
  phase with cost notes.

---

## 5. Testing and CI

- Backend Vitest + Supertest: 6 suites, ~1,840 lines
  (`api`, `authorization`, `galleries`, `photos`, `public-gallery`, `stats`).
  Pattern: mock `@clerk/backend.verifyToken` (`valid.<sub>`) and Appwrite
  (`uploadPhoto`/`deletePhotoQuietly`/`checkBucket`); Postgres is real
  (`TEST_DATABASE_URL` with migrations applied).
- CI (`.github/workflows/ci.yml`): `postgres:16` service → apply all
  migrations via `psql` → `bun run lint` → `check-types` → `test` → `build`.
  Env placeholders only; Clerk/Appwrite mocked.
- Definition of Done per change: `bun run lint && bun run check-types &&
  bun run build`, plus `bun run test` in `apps/backend` when backend
  changed. Report failures honestly; never bypass or silently skip.

---

## 6. Verified limitations (each checked in code)

1. **Photo grids load the complete set.** `listEventPhotos` has no
   `LIMIT`/`OFFSET`/cursor (`db.ts:273-294`); unlock returns every gallery
   photo (`api.ts:805`, `listGalleryPhotos db.ts:391-401`). Frontend
   `listPhotos` takes only `(token, eventId)` (`client.ts:153-155`).
   Fix in Phase 1 with backward-compatible pagination.
2. **Rate limiting is process-local.** `src/lib/rate-limit.ts`: 5 failures /
   15 min per `slug:ip`, `Map`-based, `MAX_KEYS` cap, no `Retry-After`
   header, explicitly single-process. Multi-instance Render deploys get one
   budget per process. Fix in Phase 7 with Redis + per-class limits.
3. **Gallery PINs are plaintext.** `galleries.pin text` (migration
   `…/20260909030000_galleries.sql:10`), `serializeGallery` returns `pin`
   on admin responses (`api.ts:929`), unlock compares plaintext with
   `timingSafeEqual` (`api.ts:797-799`). Hashing needs a coordinated
   migration + dual-verify window — explicitly out of Phase 0; ask before
   touching the remote DB.

---

## 7. Security, performance, reliability risks (backlog, not Phase 0 fixes)

- Security: plaintext PINs (§6.3); dashboard uses direct Appwrite view URLs
  (`photoUrl`) while only the public surface is proxied — remaining
  hardening is bucket-private end-to-end; `cors({ origin: true })`
  (`server.ts:22-29`) is safe only while credentials stay off; no UUID
  validation on params (malformed IDs → Postgres `22P02` → 500, should be
  404/400); `verifyToken` without `authorizedParties`; per-request Clerk
  `users.getUser` adds latency with no cache/timeout/breaker.
- Performance: unbounded photo reads (§6.1); N+1 already fixed for gallery
  counts (`listEventGalleriesWithCounts`) and photo-proxy
  (`isPhotoInGallery`) in unpushed `b84afc7` — still to push; upload loop is
  sequential and blocks the API; no thumbnails; `express.json({limit:"1mb"})`
  does not bound multipart (real ceiling 20 × 25 MB in heap).
- Reliability: no transactions spanning Appwrite + Postgres (crash between
  the two leaves orphans; event-delete cleanup exists in `api.ts:421-425`
  but no sweeper); no retries/idempotency keys (client discards `uploaded[]`
  on 502 → retry duplicates); in-memory limiter (§6.2); no structured
  logs/correlation IDs/metrics; no worker/consumer observability yet.
- Data integrity: `DELETE FROM users` can hit `NO ACTION` FKs
  (`photos.uploaded_by`, `galleries.created_by`, `invitations.invited_by`);
  invitation→workspace resolution is email-ordered without a unique guard
  (see `docs/AUDIT-2026-09-10.md` §5.2 — re-verify before changing).

---

## 8. Target architecture (why each piece earns its place)

```text
Browser → Next.js → Express API
                    ├── Clerk (identity only)
                    ├── Postgres (authoritative state + analytics aggregates)
                    ├── Appwrite (image binaries + future thumbnails)
                    ├── Redis + BullMQ (jobs: thumbnails; rate limits; small caches)
                    ├── Kafka (analytics/activity events → independent consumers)
                    └── Prometheus → Grafana (metrics, dashboards, alerts)
Background: thumbnail workers • analytics consumers • (later) popularity/reco jobs
```

Separation: Postgres = truth; Appwrite = bytes; BullMQ = async jobs (never
Kafka for image jobs); Kafka = analytics only, at-least-once + idempotent
consumers, never in the gallery response path; Prometheus = low-cardinality
metrics only (never visitor/gallery/email labels); Clerk = identity with
existing server-side authorization untouched. No microservices/K8s/service
mesh — modular monolith + separate worker/consumer entrypoints.

---

## 9. Dependencies and infrastructure requirements (names only, no values)

New npm deps (to be added in their phase, pinned at implementation time):
Phase 1 none; Phase 2 `sharp` (check Render/Node 24 compat, `trustedDependencies`
if Bun build needs it); Phase 3 `bullmq` + `ioredis`; Phase 4 `kafkajs`;
Phase 9 `prom-client`. No change to Clerk/Supabase/Appwrite SDKs.

New env names (examples only, real values never committed):
`REDIS_URL`, `BULLMQ_PREFIX` (optional), `KAFKA_BROKERS`, `KAFKA_CLIENT_ID`,
`KAFKA_TOPIC_ANALYTICS`, `KAFKA_CONSUMER_GROUP`, `METRICS_ENABLED` /
`METRICS_PORT` (if sidecar), plus existing `DATABASE_URL`,
`DATABASE_SSL_CA`, `CLERK_SECRET_KEY`, `APPWRITE_*`, `GALLERY_TOKEN_SECRET`.
`.env.example` files carry names only.

Local infra (new, dev-only): `docker-compose.yml` at root with Redis,
Kafka (+ KRaft, no ZooKeeper), Prometheus, Grafana; worker/consumer run as
`bun run worker:*` scripts. Production infra is a separate human-approved
step per phase with cost notes; no prod settings change in Phase 0.

---

## 10. Phase-by-phase plan

### Phase 1 — Paginated photo retrieval
Scope: `GET /events/:eventId/photos` (+ gallery photo reads where
applicable) gain backward-compatible `?limit=&cursor=` (cursor = opaque
`created_at+id`), `?order=` fixed `desc`, `max 100`, stable ordering,
`{ photos, next_cursor, has_more }`; keep workspace/assignment/gallery
visibility gates; frontend progressively loads without UI redesign.
Files: `src/lib/db.ts` (new paginated queries), `src/routes/api.ts`
(params + metadata), `apps/frontend/src/lib/api/client.ts` + photo grid
callers, migration only if an index is needed, tests.
Tests: empty pages, invalid limit/cursor, ordering determinism, boundary
`has_more`, 403 isolation, unlock-flow unchanged.
Acceptance: large collections page incrementally; existing auth tests green;
documented contract.

### Phase 2 — Thumbnails + derivatives
Scope: `photo_derivatives` table (photo FK, variant, storage_file_id,
width/height/bytes, status state machine
`UPLOADED → QUEUED → PROCESSING → READY` + `FAILED`, attempts,
last_error, timestamps); `sharp`-based variants (e.g. `thumb_320`,
`thumb_960`, `webp` where input allows); MIME + magic-byte + dimension
guards; originals immutable; gallery never serves a photo as READY until
required derivatives exist; status queryable.
Tests: invalid/corrupt images, duplicate jobs, worker crash mid-job,
permission gates, path-traversal rejection.

### Phase 3 — Redis + BullMQ jobs
Scope: queue module outside route handlers, `worker/thumbnails.ts`
entrypoint, bounded concurrency, retries with exponential backoff + job
timeout, idempotency keys (`photoId:variant`), Postgres as status truth
(not Redis), outbox-or-reconciliation documented for
created-but-not-enqueued and crashed-worker cases, health checks +
structured logs, graceful shutdown, Redis-down visibility.
Commits: (a) queue infra + local compose, (b) thumbnail integration.
Tests: enqueue failure recovery, retry/backoff, duplicate submit safety,
stuck-job detection, Redis-down behavior.

### Phase 4 — Kafka event contracts + infra
Scope: versioned schemas (`GalleryViewed`, `PhotoViewed`,
`PhotoDownloaded`, `GalleryDownloaded`, `GalleryShared`) with `eventId`,
`eventType`, `schemaVersion`, `occurredAt`, `galleryId`, `workspaceId`,
pseudonymous `visitorId`, normalized source, correlation ID — never PINs,
tokens, credentials, or full URLs; topic/partition-key (gallery id)/
retention documented; modular producer/consumer; fire-and-forget produce
off the gallery path; at-least-once + idempotent writes; offsets after
work; local Compose + hosted-Kafka notes.
Commits: (a) contracts, (b) infra, (c) gallery integrations.
Tests: schema validation, producer error paths, duplicate delivery,
restart/offset semantics.

### Phase 5 — Views / uniques / sources
Scope: analytics consumer → Postgres aggregates (`gallery_daily_stats`,
`gallery_visitor_hashes` or equivalent), view defined as successful PIN
unlock rendering (documented; alternatives rejected explicitly);
dedupe by `eventId`; first-party pseudonymous visitor id with consent +
retention notes; referrer/UTM normalization (unknown/direct/identified);
workspace-scoped admin endpoints; tz-consistent bucketing (UTC day).
Tests: duplicates, missing referrers, concurrent upserts, isolation.

### Phase 6 — Engagement (photo views/downloads, gallery downloads/shares)
Scope: instrument the four interactions with numerator/denominator
definitions (e.g. download rate = sessions-with-download /
eligible-sessions); bounded event volume; no retry-duplicate clicks;
workspace-scoped endpoints; classification + calculation tests.

### Phase 7 — Redis rate limiting + bot signals
Scope: replace process-local limiter per endpoint class (PIN unlock,
auth-sensitive, uploads, public reads, expensive ops) with Redis
token/sliding-window, 429 + `Retry-After`, multi-instance correctness,
fail-open vs fail-closed per class (sensitive = closed), no trusting
`X-Forwarded-For` beyond `trust proxy: 1` review, minimal IP logging,
Kafka signals for reporting only (blocking stays synchronous).
Tests: thresholds, cross-instance (two-client) behavior, Redis-down
policies, legitimate shared-IP traffic.

### Phase 8 — Popular galleries
Scope: deterministic ranking (eligible views/uniques/downloads, all-time +
recent windows, unpublished excluded/classified separately, bot-filter
policy documented), indexed aggregates, reproducible queries, no
cross-workspace leakage via analytics endpoints.
Tests: known-dataset rankings, windows, ties, private-gallery invisibility.

### Phase 9 — Prometheus + Grafana
Scope: `prom-client` counters/histograms/gauges (HTTP count/latency/errors,
processing duration/failures, queue depth/age, worker concurrency/retries,
consumer lag/errors, Redis failures, DB latency); low-cardinality labels;
private `/metrics`; request IDs + structured logs; Compose dashboards +
alert examples; prod setup documented separately; degrade-safe when
monitoring is down. Tests/smoke: metrics endpoint, label cardinality guard.

### Phase 10 — Recommendation foundation
Scope: deterministic baseline (same-category/tag, recent-popular,
content-similarity, workspace-scoped admin picks) with cold-start fallback,
bounded queries, private-galleries-never-public rule, evaluation dataset +
offline check before any ML claim. Trained models are a later optional
extension, not this track.

---

## 11. Risks, rollback, acceptance (global)

- Risks: new infra (Redis/Kafka) raises local + prod complexity and cost;
  background processing introduces eventual consistency (derivatives,
  analytics lag); PIN hashing is a lockout risk without dual-verify;
  high-cardinality metrics or visitor-ID labels would be a privacy/cost bug.
- Rollback per phase: additive migrations with compatible reads (new tables/
  columns nullable or backfilled; no `DROP` without approval); feature flags
  or env-gated producers/consumers/workers so each phase can ship dark;
  queue/consumer offsets + DLQs allow replay; dashboards versioned in repo.
  Rollback = stop producer/worker, keep serving from Postgres truth, replay
  or backfill on re-enable. Anything destructive needs explicit human
  approval first.
- Acceptance: §10 per-phase criteria plus global Definition of Success
  (§12 of master prompt): paginated delivery, async processing with safe
  retries, idempotent Kafka analytics, uniques/sources, shared limits,
  rankings, observable API/queue/consumers, documented reco baseline,
  reproducible local dev + green lint/types/tests/build, clean incremental
  history with no secrets.

---

## 12. Commit plan (small conventional commits, adapted to reality)

- `docs: add system design implementation plan` ← this commit (Phase 0)
- `feat: add paginated event photo queries` (+ `test: cover photo pagination`)
- `feat: add photo derivative schema` / `feat: add thumbnail pipeline`
- `feat: add Redis BullMQ queue infrastructure` / `feat: integrate thumbnail jobs`
- `docs: add analytics event contracts` / `feat: add Kafka producer consumer infra`
- `feat: add gallery view analytics aggregation` (+ endpoints)
- `feat: add engagement event instrumentation`
- `feat: add Redis-backed rate limiting`
- `feat: add popular gallery rankings`
- `feat: add Prometheus metrics and Grafana dashboards`
- `feat: add recommendation baseline` / `docs: …`
- Docs accompany each behavior change; pushes only on explicit approval;
  never force-push, never amend unrelated history.

---

## 13. What Phase 1 needs before it starts

Nothing external: Postgres + existing test harness suffice. No new env vars,
no infra, no prod changes. Open items for the human (non-blocking for
Phase 1): confirm managed Redis/Kafka vendors when Phases 3–4 approach;
approve PIN-hash migration strategy before any PIN work; confirm whether
the two unpushed `main` commits (`b84afc7`, `eb90bd2`) should be pushed
first so `feat/system-design-upgrades` stays cleanly rebased.
