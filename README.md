# FrameFlow

<p align="center">
  <img src="docs/frameflow-logo.svg" alt="FrameFlow logo" width="720" />
</p>

FrameFlow is a photo-sharing platform for photography and event teams. An
admin creates an event, adds team members, receives their uploads, selects the
photos for delivery, and publishes a PIN-protected gallery for the customer.

Customers do not need an account. They receive a gallery link and a six-digit
PIN, then view the published photos through the public gallery route.

Built for the TrizenAI full-stack internship challenge.

## Live deployment

- Frontend: https://trizen-ai-frontend.vercel.app
- Backend health: https://trizen-ai.onrender.com/health
- API health: https://trizen-ai.onrender.com/api/v1/health

The frontend is deployed on Vercel. The backend is packaged as a Docker image
and deployed as a Render web service.

## Product workflow

1. An admin registers and signs in through Clerk.
2. The admin creates an event. New events start in `draft` status.
3. The admin adds a team member from the Team page.
4. The team member registers with the invited email and becomes a
   `TEAM_MEMBER` in the admin's workspace.
5. The admin opens the event's Team tab and assigns an active team member from
   the workspace member selector.
6. The team member sees the assigned event and uploads photos to it.
7. The admin sees all event photos, selects the photos for delivery, and creates
   a gallery.
8. The admin publishes the gallery and shares its URL and six-digit PIN.
9. The customer opens the URL, enters the PIN, and browses the published
   gallery without signing in.

If Clerk production email delivery is not configured with a verified sending
domain, the admin can create a pending member and share the registration URL
manually. The member must use the exact email entered by the admin.

## Roles and permissions

### Admin / Lead

Admins can create, edit, delete, and change event status; manage workspace team
members; assign members to events; view every photo in their workspace events;
curate photos; create and publish galleries; set or regenerate gallery PINs;
and share customer gallery URLs.

Event statuses are `draft`, `active`, and `completed`. Gallery status is
separate and uses `draft` and `published`.

### Team Member

Team members can sign in, view assigned events, upload photos, and view only
their own uploaded photos in those events. They cannot manage users, assign
members, view galleries, curate photos, create galleries, publish galleries,
or delete photos.

### Customer

Customers have no application account. They open a shared gallery URL, enter
the six-digit PIN, browse published photos, and download individual photos.

## Technology stack

| Layer            | Technology                           | Responsibility                                      |
| ---------------- | ------------------------------------ | --------------------------------------------------- |
| Frontend         | Next.js 16, React 19, Tailwind CSS 4 | Dashboard, upload, gallery and customer UI          |
| Authentication   | Clerk                                | Sign-in, sign-up, sessions and invitations          |
| Backend          | Express 5, TypeScript, Node.js 24    | API, authorization, validation and business rules   |
| Database         | Supabase PostgreSQL                  | Users, workspaces, events, assignments and metadata |
| File storage     | Appwrite Storage                     | Photo binaries only                                 |
| Testing          | Vitest, Supertest                    | API, authorization and workflow tests               |
| Observability    | Prometheus, Grafana, prom-client     | Metrics, dashboards and alert examples (dev stack)  |
| Monorepo         | Turborepo, Bun                       | Workspace scripts, dependencies and builds          |
| Frontend hosting | Vercel                               | Next.js production deployment                       |
| Backend hosting  | Render                               | Dockerized Express production service               |

## Architecture

```text
Browser
   |
   | Clerk session token in Authorization header
   v
Vercel - Next.js frontend
   |
   | HTTPS API requests
   v
Render - Dockerized Express backend
   |\
   | \-- Clerk Backend SDK: identity and invitations
   |\
   |  \- Supabase PostgreSQL: application metadata
   |\
   \---- Appwrite Storage: photo binaries
```

The browser never connects directly to PostgreSQL or Appwrite using server
credentials. Frontend requests go through
`apps/frontend/src/lib/api/client.ts`. The backend verifies the Clerk bearer
token and derives the user, role, and workspace from trusted server-side data.

### Authenticated request flow

1. Clerk creates the browser session.
2. The frontend obtains a Clerk session token.
3. The token is sent as `Authorization: Bearer <token>`.
4. Express verifies the token with `@clerk/backend`.
5. The backend resolves the application user and role from PostgreSQL.
6. Workspace and event membership checks run before protected operations.

### Public gallery flow

```text
GET  /api/v1/public/galleries/:slug
POST /api/v1/public/galleries/:slug/unlock  { pin }
GET  /api/v1/public/galleries/:slug/photos/:photoId?st=<token>
```

The PIN is checked server-side. A successful unlock creates a short-lived,
gallery-bound signed token. Photo bytes are proxied from Appwrite through the
backend.

## Database design

The schema is versioned under `supabase/migrations/`.

```text
workspaces
   |
   +-- users
   |      |
   |      +-- invitations
   |      |
   |      +-- event_team_members -- events -- photos
   |                                      |
   |                                      +-- galleries -- gallery_photos -- photos
```

- `workspaces` is the tenancy boundary.
- `users` stores the verified Clerk ID, role, email, and workspace.
- `invitations` stores pending workspace invitations and their status.
- `events` belongs to one workspace and has a lifecycle status.
- `event_team_members` is the relationship that grants event access.
- `photos` stores metadata only: event, uploader, filename, storage ID, MIME
  type, size, and timestamps.
- `galleries` stores event-scoped gallery metadata, slug, PIN, and status.
- `gallery_photos` stores the admin's selected photo set.

PostgreSQL stores metadata only. Image files are stored in Appwrite.

## API overview

All application routes are under `/api/v1`.

| Area             | Routes                                      | Access                                             |
| ---------------- | ------------------------------------------- | -------------------------------------------------- |
| Health           | `GET /health`, `GET /api/v1/health`         | Public                                             |
| Identity         | `GET /api/v1/me`                            | Authenticated                                      |
| Dashboard        | `GET /api/v1/stats`                         | Authenticated, role-scoped                         |
| Workspace team   | `/team-members` and related routes          | Admin                                              |
| Events           | `/events` CRUD                              | Reads authenticated; writes admin                  |
| Event assignment | `/events/:id/team-members`                  | Admin                                              |
| Photos           | `/events/:id/photos`, `/photos/:id`         | Assigned member upload/read-own; admin full access |
| Galleries        | `/events/:id/galleries`, `/galleries/:id/*` | Admin                                              |
| Analytics        | `/analytics/*`                              | Admin, workspace-scoped                            |
| Public galleries | `/public/galleries/:slug/*`                 | Public, PIN/token protected                        |

Errors use a consistent response shape:

```json
{ "error": "A safe user-facing message" }
```

Internal error details are logged server-side and are not returned to clients.

### Photo pagination

Photo lists are cursor-paginated — event collections and the public gallery
surface never return unbounded arrays:

```text
GET /api/v1/events/:eventId/photos?limit=50&cursor=<opaque>&order=newest|oldest
POST /api/v1/public/galleries/:slug/unlock?limit=50&cursor=<opaque>  { pin }
GET /api/v1/public/galleries/:slug/photos?st=<token>&limit=50&cursor=<opaque>
```

- `limit` is 1–100 (default 50); anything else is `400`.
- `cursor` is an opaque base64url token from the previous page's
  `pagination.next_cursor`; malformed cursors are `400`.
- Every list responds `{ photos: [...], pagination: { limit, next_cursor,
  has_more } }`. Follow `next_cursor` while `has_more` is true.
- Event ordering is stable (`created_at`, `id`); gallery ordering follows
  curation order (`added_at`, `photo_id`). Same-millisecond uploads cannot
  duplicate or skip rows across pages.
- Authorization is unchanged: workspace/event gates run before pagination,
  and the public follow-up endpoint re-verifies the signed unlock token.
- The unlock response keeps its shape (`gallery`, `access_token`,
  `expires_at`) and adds `pagination`; `gallery.photo_count` is the total.

### Image derivatives

Uploads enqueue two thumbnail variants per photo (`thumb_small` 320w,
`thumb_large` 960w, WebP) and return `201` without waiting — a background
sweep processes them through `QUEUED → PROCESSING → READY` (`FAILED` after
3 attempts, with `last_error` kept on the row). Photo responses carry
`processing_status` plus per-variant `status`/`url` (URL only when READY);
grids render thumbnails with the original as fallback. The customer proxy
serves `.../photos/:photoId?st=<token>&variant=thumb_small` (`409` while
not ready, `400` for unknown variants). Failures are retried explicitly:

```text
POST /api/v1/photos/:photoId/derivatives/retry   (admin, workspace-scoped)
```

Stuck `PROCESSING` rows (crashed worker) are re-queued automatically.
Originals are never modified; deleting a photo or event also removes its
derivative binaries (best-effort, like originals). Legacy photos uploaded
before this feature read as `QUEUED` until the retry endpoint enqueues them.

### Background jobs (Redis + BullMQ)

Thumbnail work runs in a separate worker process when Redis is configured:

```sh
docker compose up redis -d          # local Redis on :6379
# apps/backend/.env.local:  REDIS_URL=redis://localhost:6379

bun run dev --filter=backend        # API (:4000)
cd apps/backend && bun run worker:thumbnails:watch   # worker (separate terminal)
```

Production runs the compiled worker as its own service
(`node dist/workers/thumbnails.js`) with `REDIS_URL` pointing at managed
Redis. Without `REDIS_URL`, everything still works: the API falls back to
the in-process sweep.

- Uploads publish one job per variant (`dv:<photoId>:<variant>`) with
  3 attempts, exponential backoff (5s base), a 120s processor timeout, and
  bounded worker concurrency (2). Replies never wait for jobs.
- PostgreSQL stays authoritative: jobs that find a `READY` row or lose the
  `PG` claim race are skips, so redelivery never duplicates derivatives.
- Recovery without an outbox (deliberate): a repeatable reconciler job
  (every 60s) re-queues crashed rows and republishes anything still
  `QUEUED`/`FAILED`-with-budget — including photos created while Redis was
  down. A transactional outbox would narrow the already-small loss window
  (enqueue-then-publish crash) at the cost of a relay poller and new tables;
  the reconciler bounds that window to ~60s with visible `QUEUED` rows, so
  the outbox was deferred. Publish failures also trigger the in-process
  sweep immediately, and the admin retry endpoint always works.
- `GET /api/v1/queues/derivatives` (admin) reports BullMQ counts
  (`configured: false` without Redis, `503` when Redis is unreachable).
  Worker logs are single-line JSON with no secrets; `SIGTERM`/`SIGINT`
  drain active jobs before exit.

### Analytics events (Kafka)

Customer interactions emit versioned events (`GalleryViewed`,
`PhotoViewed`, `PhotoDownloaded`, `GalleryDownloaded`, `GalleryShared`;
contract v1 in `apps/backend/src/lib/analytics-events.ts`):

```sh
docker compose up kafka -d            # local Kafka on :9092
# apps/backend/.env.local:  KAFKA_BROKERS=localhost:9092

cd apps/backend && bun run worker:analytics:watch   # consumer (separate terminal)
```

- Emission points today: successful gallery unlock (`GalleryViewed`) and
  proxied photo serving (`PhotoViewed` inline, `PhotoDownloaded` for
  `dl=1`). Dashboard downloads use direct Appwrite URLs and are not
  observable server-side — `PhotoDownloaded` currently covers customer
  proxied downloads only.
- Events carry ids, timestamps, a pseudonymous `visitorId`, a per-unlock
  `correlationId`, and a normalized traffic source — never PINs, tokens,
  credentials, emails, IPs, or full URLs. The unlock response echoes
  `visitor_id`/`correlation_id`; photo URLs carry `v=`/`c=` (img tags
  cannot set headers). The frontend mints the visitor id into
  `localStorage` (`x-visitor-id` header); clearing site data resets it.
  Unique-visitor counts are therefore estimates, not identities.
- Events also carry a transparent `clientClass` (`human` / `bot` /
  `suspicious`) classified from the User-Agent. This is an analytics
  annotation only — it never blocks traffic — and legacy rows stay NULL,
  treated exactly like `human` for eligibility.
- Delivery honesty: producers fire-and-forget *after* the response with a
  3s timeout — Kafka outages only log, galleries keep serving, and a crash
  between serving and emitting loses that event (accepted: aggregates are
  estimates). Consumers are at-least-once: one topic
  (`frameflow.analytics.v1`), partitioned with gallery-id keys, consumer
  group `frameflow-analytics-v1`; offsets commit only after the validated
  event is stored, and redelivery dedupes on the `event_id` primary key.
  No transactional outbox: the loss window is small and loss-tolerant, so
  the extra relay was deferred (same reasoning as the thumbnail
  reconciler).
- Raw events land in `analytics_event_log` (no FK to galleries — analytics
  outlive deletions, workspace-scoped by a denormalized column). Phase 5
  aggregates read from this table.
- Production: hosted Kafka with an explicitly created topic (gallery-keyed
  partitions, 7-day retention to match local compose) plus a separate
  worker service. Vercel/Render provide no Kafka — this is external
  infrastructure with its own cost.

### Analytics definitions (views, uniques, sources)

One **view** = one successful gallery unlock (one `GalleryViewed` event).
Re-entering the PIN counts as a new view; redelivery of the *same* event
(same `eventId`) never counts twice — the raw log's primary key plus
conditional aggregation enforce that. Initial page loads that 404, failed
PINs, and rate-limited attempts are not views.

**Unique visitors** are visitor-day estimates, not person counts: the
frontend sends a pseudonymous client-minted UUID (`localStorage`, reset by
clearing site data), stored as a SHA-256 hash in one row per
(gallery, UTC day, hash). Cookie deletion, multiple devices, shared links,
and missing ids (counted as views, never as uniques) all skew the number.
Range uniques are exact distinct-hash counts over the window — never summed
daily uniques.

**Traffic sources** are `direct` (no referrer), `unknown` (unparseable), or
a normalized hostname (`www.` stripped, length-capped, path/query dropped)
with optional UTM medium/campaign passthrough. Referrers are untrusted
input. All buckets are UTC days from the event's `occurredAt`.

```text
GET /api/v1/analytics/overview?from=YYYY-MM-DD&to=YYYY-MM-DD          (admin)
GET /api/v1/analytics/galleries/:galleryId?from=YYYY-MM-DD&to=YYYY-MM-DD  (admin)
```

Both default to the trailing 30 days (max one year, `400` otherwise),
return zero-filled daily series plus per-source views/uniques, and are
workspace-scoped: team members get `403`, foreign-workspace galleries
`404` exactly like missing ones. Customer gallery endpoints are unchanged.

### Engagement definitions (views, downloads, shares, rates)

Every stored event counts exactly once (same `eventId` redelivery is a
no-op, including under concurrent consumers):

- `photo_views[photo]` / `photo_downloads[photo]` — `PhotoViewed` /
  `PhotoDownloaded` counts per photo and day. Served inline vs `dl=1`
  decides the classification server-side; clients cannot mislabel.
- Gallery `photo_views` / `photo_downloads` / `shares` — windowed sums;
  `shares` counts `GalleryShared` clicks from the customer Share button
  (`native` vs `clipboard` channel).
- `download_rate` — DISTINCT download sessions / DISTINCT sessions over the
  window, or `null` when there are no sessions. A session is one unlock
  correlation id, and every session renders the gallery, so every session
  is eligible — stated denominator, not a "CTR". Computed at read time from
  the raw log (exact distinct counts, UTC-bounded); counters come from the
  rollups. No per-photo uniques by design (counts only; uniques stay
  gallery-level).
- `top_photos` — top 10 by views (then downloads, then id) with filenames
  best-effort (`null` after a photo is deleted; counts survive).
- `GalleryDownloaded` is contracted but dormant: no bulk export exists, so
  nothing emits it yet. Share clicks send once per gesture with no retry —
  a failed report is dropped, never repeated, so retries can't inflate.
- Event volume stays bounded: one event per unlock, photo serve, download,
  or share click — no scroll/hover tracking, no new visitor data beyond
  Phase 4's pseudonymous id.

### Popular galleries (ranking)

`GET /api/v1/analytics/popular-galleries?from=YYYY-MM-DD&to=YYYY-MM-DD`
(or `?all=true` for all-time; `?limit=` 1–50, default 10; admin only,
workspace-scoped) ranks the workspace's galleries by eligible engagement:

- **Order is total and deterministic**: views, then exact window uniques,
  then downloads, then gallery id ascending — same log, same window, same
  ranking. Every number is a direct aggregate of `analytics_event_log`
  (covered by a partial ranking index), never a cached score, so the result
  is reproducible and recomputable.
- **Eligible** is the documented bot policy: `client_class = 'bot'` events
  never count; `human`, `suspicious` (conservative — may be legitimate
  kiosks), and `NULL` (unclassified pre-Phase-7 rows) all count.
- **Views** are eligible `GalleryViewed` events, **uniques** are exact
  distinct visitors over the whole window (not summed daily uniques), and
  **downloads** are eligible `PhotoDownloaded` counts. A gallery needs at
  least one eligible view to rank.
- **Draft galleries never rank** — they are reported separately as
  `excluded_drafts` (drafts that would have ranked). Published galleries
  with no activity are absent; deleted galleries drop out while their
  events stay in the log for history.
- Windowed mode reuses the analytics range rules (trailing 30 days by
  default, one-year cap). `?all=true` is deliberately unbounded: the
  all-time read scans the raw log end to end, the one query here whose cost
  grows with history (see Known limitations).

```json
{
  "range": { "from": "2026-05-01", "to": "2026-05-31" },
  "rankings": [
    { "rank": 1, "gallery_id": "…", "name": "…", "slug": "…",
      "views": 42, "unique_visitors": 17, "downloads": 9 }
  ],
  "excluded_drafts": 2
}
```

### Rate limiting & abuse protection

Distributed sliding-window limits guard every expensive or enumerable
surface. When `REDIS_URL` is configured the windows live in Redis (atomic
Lua scripts), so one budget is shared across all API instances — the
correct model behind a load balancer. Without Redis (local dev, tests) the
in-process window applies, and it is also the per-class degraded fallback
when Redis is unreachable. Blocked requests answer `429` with
`Retry-After`; bucket keys are SHA-256 hashes of the class and material, so
raw IPs and user ids never reach Redis, logs, or error messages.

| Class         | Limit | Window | Key       | Purpose                            |
| ------------- | ----- | ------ | --------- | ---------------------------------- |
| `pin-failure` | 5     | 15 min | slug + IP | PIN brute force (failure window)   |
| `pin-attempt` | 30    | 15 min | slug + IP | unlock flood guard (all attempts)  |
| `public-read` | 600   | 1 min  | IP        | gallery metadata / photo floods    |
| `upload`      | 30    | 10 min | user      | upload floods                      |
| `admin`       | 300   | 10 min | user      | admin API floods                   |
| `provision`   | 120   | 5 min  | IP        | signup/provision floods            |

- PIN semantics: every unlock attempt draws from `pin-attempt`; a wrong PIN
  additionally fills the 5-failure `pin-failure` window; a correct PIN
  clears it. Blocked requests never extend their own lockout, and buckets
  are scoped per slug — one attacked gallery cannot lock another.
- Degradation is per class, deliberately: sensitive classes (PIN, upload,
  admin) fall back to the in-process window, so protection never silently
  drops; non-sensitive classes (`public-read`, `provision`) fail OPEN — a
  Redis outage must not take the customer surface down. The outage is
  logged once (`scope: "rate-limit"`) and a 15s cooldown keeps a dead Redis
  from adding latency to every request.
- Client classification is reporting-only: the User-Agent is classified
  (`human` / `bot` / `suspicious`) and stamped onto analytics events (see
  `analytics_event_log.client_class`). It never blocks a request — the
  limiter applies equally to bots and humans — and `bot` events are
  excluded from popularity-ranking inputs.
- Redis being unset in production is a deployment gap, not a design
  choice: the in-memory fallback protects one instance only, which is why
  CI runs the limiter suite against real Redis.

### Observability (Prometheus + Grafana)

Every process exports Prometheus metrics via `prom-client`. Collection is
in-process and failure-isolated: Prometheus or Grafana being down never
affects serving, and a worker whose metrics sidecar fails to bind logs the
error and keeps working.

| Surface          | Endpoint                         | Notes                                   |
| ---------------- | -------------------------------- | --------------------------------------- |
| API              | `GET /metrics` on port 4000      | infra surface — no Clerk auth (see gate) |
| Thumbnail worker | `http://localhost:9464/metrics`  | sidecar; `METRICS_PORT` overrides       |
| Analytics worker | `http://localhost:9472/metrics`  | sidecar; `METRICS_PORT` overrides       |

Exposure policy: enabled by default only when `NODE_ENV=development`;
production opts in with `METRICS_ENABLED=true`. When `METRICS_TOKEN` is set,
the API route and the worker sidecars require `Authorization: Bearer
<token>` (constant-time compare); without it, keep the ports off the public
internet.

What is exported: HTTP request counts (route pattern, method, status) and
latency histograms; PostgreSQL query latency by statement kind; BullMQ queue
depth, oldest-waiting age, worker concurrency, job completion/failure and
retries; derivative job outcomes and durations; Kafka consumer lag per
partition; analytics ingest outcomes (stored / duplicate / invalid) and
batch errors; Redis fallback errors; plus the default process metrics.
Labels are strictly bounded — route **patterns** (never raw URLs), fixed
outcome enums, topic/partition — so series count cannot grow with traffic;
requests that match no route collapse into `route="unmatched"`.

Local stack:

```sh
docker compose up -d prometheus grafana   # Grafana at http://localhost:3030 (admin/admin)
```

Prometheus scrapes the host-run API and workers every 15s
(`infra/prometheus/prometheus.yml`) and loads example alert rules
(`infra/prometheus/alerts.yml`) that are validated with `promtool`. Grafana
comes provisioned with the datasource and the FrameFlow dashboard
(`infra/grafana/`): request rate/errors/latency, DB latency, queue health,
worker outcomes, consumer lag, and analytics ingest.

## Security model

- Clerk is the only identity provider. Supabase Auth and custom JWTs are not
  used.
- The backend verifies every authenticated Clerk token.
- User IDs, uploader IDs, roles, and workspace IDs are never trusted from the
  browser.
- Roles are read from PostgreSQL, not from client state.
- Every workspace query is scoped to the authenticated user's workspace.
- Team members need an `event_team_members` row to access an event.
- Team-member photo reads are filtered by the authenticated uploader ID.
- Uploads accept JPEG, PNG, and WebP files with a 25 MB per-file limit.
- Gallery PIN attempts are rate-limited per gallery and IP address —
  distributed via Redis when configured, with per-class degraded fallbacks
  (see Rate limiting & abuse protection).
- Unpublished galleries are not exposed through the public API.
- Public gallery photos use signed, time-limited backend URLs.
- Secrets are validated at backend startup and are never committed to Git.

## Repository structure

```text
.
├── apps/
│   ├── frontend/              # Next.js application
│   └── backend/               # Express API and Dockerfile
├── packages/                  # Shared workspace configuration
├── infra/                     # Prometheus + Grafana provisioning (dev)
├── supabase/migrations/       # Versioned PostgreSQL migrations
├── .github/workflows/ci.yml   # GitHub Actions checks
├── turbo.json
├── package.json
└── bun.lock
```

## Local development

Requirements: Bun 1.x, Node.js 24+, PostgreSQL with the migrations applied, a
Clerk development instance, and an Appwrite project with a storage bucket.

```sh
bun install
cp apps/frontend/.env.example apps/frontend/.env.local
cp apps/backend/.env.example apps/backend/.env.local
```

Apply the SQL migrations to the development database, then start the apps in
separate terminals:

```sh
bun run dev --filter=frontend
bun run dev --filter=backend
```

The frontend runs on `http://localhost:3000`; the backend runs on
`http://localhost:4000`. `docker compose up -d` brings up the optional
local infrastructure: Redis, Kafka, and the Prometheus/Grafana
observability stack (see Observability).

Useful commands:

```sh
bun run lint
bun run check-types
bun run build
bun run test
```

## Environment variables

### Frontend: `apps/frontend/.env.local`

```dotenv
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
NEXT_PUBLIC_API_URL=http://localhost:4000
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/login
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/register
NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/dashboard
NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/dashboard
```

`NEXT_PUBLIC_*` values are exposed to the browser. `CLERK_SECRET_KEY` is
server-only and is required by the Next.js Clerk proxy configuration.

### Backend: `apps/backend/.env.local`

```dotenv
DATABASE_URL=postgresql://user:password@host:port/database
DATABASE_SSL_CA=./prod-ca-2021.crt
CLERK_SECRET_KEY=sk_test_...
APPWRITE_ENDPOINT=https://cloud.appwrite.io/v1
APPWRITE_PROJECT_ID=your-project-id
APPWRITE_API_KEY=your-server-api-key
APPWRITE_BUCKET_ID=photos
GALLERY_TOKEN_SECRET=replace-with-a-long-random-secret
NODE_ENV=development
PORT=4000
```

`DATABASE_SSL_CA` is required in production for a remote PostgreSQL database.
`GALLERY_TOKEN_SECRET` should be a separate random secret in production. Real
values must never be committed.

Optional observability variables (defaults suit local development — see
Observability): `METRICS_ENABLED=true` turns the endpoints on
(default: on only when `NODE_ENV=development`), `METRICS_TOKEN` gates them
behind `Authorization: Bearer <token>`, and `METRICS_PORT` overrides a
worker sidecar port.

## Production deployment

### Supabase

1. Create or select the production project.
2. Apply every file in `supabase/migrations/` in filename order.
3. Copy the transaction-pooler connection string into Render's
   `DATABASE_URL`.
4. Keep the production Supabase CA certificate at
   `apps/backend/prod-ca-2021.crt` so the Docker image can verify TLS.

### Appwrite

Create the production project and image bucket, then create a server API key
with only the storage permissions required by the backend. Add the endpoint,
project ID, API key, and bucket ID to Render.

### Backend on Render

The Render service uses the repository root as the Docker build context:

```text
Environment: Docker
Dockerfile path: apps/backend/Dockerfile
Docker build context: repository root (.)
Health check path: /health
Branch: main
```

Build locally with:

```sh
docker build -f apps/backend/Dockerfile -t frameflow-backend .
```

Required Render variables:

```dotenv
NODE_ENV=production
CLERK_SECRET_KEY=sk_live_...
DATABASE_URL=your-production-supabase-connection-string
DATABASE_SSL_CA=./prod-ca-2021.crt
APPWRITE_ENDPOINT=https://cloud.appwrite.io/v1
APPWRITE_PROJECT_ID=your-production-project-id
APPWRITE_API_KEY=your-production-server-api-key
APPWRITE_BUCKET_ID=your-production-bucket-id
GALLERY_TOKEN_SECRET=your-long-random-production-secret
```

The application binds to `0.0.0.0` and uses Render's `PORT` value. Verify the
service after deployment:

```sh
curl https://trizen-ai.onrender.com/health
curl https://trizen-ai.onrender.com/api/v1/health
```

### Frontend on Vercel

Connect the repository to Vercel and deploy the `apps/frontend` Next.js app.
Set these Production variables:

```dotenv
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_...
CLERK_SECRET_KEY=sk_live_...
NEXT_PUBLIC_API_URL=https://trizen-ai.onrender.com
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/login
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/register
NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/dashboard
NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/dashboard
```

Redeploy after changing any `NEXT_PUBLIC_*` value because those values are
embedded during the Next.js build.

### Clerk production setup

1. Use the Production Clerk instance for the Vercel deployment.
2. Add the Vercel URL to Clerk's allowed origins and redirect URLs.
3. Confirm `/login`, `/register`, `/dashboard`, and the Clerk proxy path in
   production.
4. Configure a verified sending domain if production invitation emails are
   required.

Without a verified email domain, use the pending-member flow and share the
registration URL manually. Never put `CLERK_SECRET_KEY` in frontend code or a
`NEXT_PUBLIC_*` variable.

## Testing

Vitest and Supertest cover authentication, role checks, workspace isolation,
event assignment, assigned-event visibility, upload authorization, uploader
attribution, file validation, gallery creation, publishing, PIN changes, rate
limiting, signed public gallery access, popular-gallery ranking (order,
windows, ties, bot filter, draft reporting, isolation), and the metrics
surface (exposure gating, token enforcement, label-cardinality guard).

```sh
bun run lint
bun run check-types
bun run test
bun run build
```

The database-backed integration suites require `TEST_DATABASE_URL` with the
migrations applied. The Redis-backend rate-limiter tests require
`REDIS_TEST_URL` (they skip themselves with a warning when it is unset).
GitHub Actions provisions PostgreSQL and Redis, applies migrations, and runs
the verification pipeline on pushes to `main` and pull requests.

## Known limitations

- Production Clerk invitation emails require a verified sending domain; the
  manual pending-member flow is available without one.
- Gallery PINs are currently stored as plaintext in PostgreSQL.
- Rate limiting is Redis-backed when `REDIS_URL` is set (shared across
  instances) and per-process otherwise; without Redis the fallback
  degrades per class — see Rate limiting & abuse protection.
- Authenticated dashboard previews use Appwrite view URLs; public gallery
  photos use the signed backend proxy.
- Photo grids page through cursor-paginated APIs and prefer thumbnail
  URLs with full-size fallback.
- Popular-gallery all-time rankings aggregate the raw log directly; at
  large event volumes this is the first read whose cost grows with history
  (windowed rankings stay bounded, and a rollup optimization is the
  natural next step if volume demands it).
- Alert rules are dev examples (`infra/prometheus/alerts.yml`); production
  alerting still needs an Alertmanager or Grafana contact-point setup.
- Metrics endpoints are open unless `METRICS_TOKEN` is set — production
  must network-gate them or configure the token.
- Bulk ZIP downloads, gallery expiry, and gallery unpublish are not included.

## License

This repository was created as an internship challenge submission.
