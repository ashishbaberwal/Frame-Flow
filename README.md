# FrameFlow

A full-stack photo-sharing platform for photography and event teams: admins
create events and manage the team, members upload photos collaboratively, and
the admin curates and publishes a PIN-protected gallery that clients open
through a shareable link — no account required.

Built for the **TrizenAI Full-Stack Internship Challenge**.

---

## Table of contents

- [Features](#features)
- [Technology stack](#technology-stack)
- [Architecture](#architecture)
- [Database design](#database-design)
- [API surface](#api-surface)
- [Security model](#security-model)
- [Local setup](#local-setup)
- [Environment variables](#environment-variables)
- [Tests](#tests)
- [Deployment](#deployment)
- [Demo credentials](#demo-credentials)
- [Known limitations](#known-limitations)

## Features

**Admin / Lead**
- Register / login (Clerk)
- Create and manage events (draft / active / completed)
- Invite team members by email (role is stamped at invite time)
- View every photo the team uploaded, with uploader attribution
- Multi-select photos, curate, and publish client galleries
- Gallery PIN is generated server-side — or set a custom one / regenerate at any time
- Shareable gallery URL (`/gallery/<slug>`) + 6-digit PIN

**Team Member**
- Login; sees **only** events they're assigned to (403 otherwise)
- Uploads photos in batches (up to 20 × 25 MB, JPEG/PNG/WebP) with progress
- Cannot publish galleries, manage users, or delete others' photos

**Customer**
- Opens the gallery link, enters the 6-digit PIN — no signup
- Browses photos in an editorial gallery view; downloads individual photos
- Brute-force protection: 5 wrong PINs per gallery+IP per 15 minutes

## Technology stack

| Layer | Choice | Why |
| --- | --- | --- |
| Frontend | Next.js 16 (App Router), React 19, Tailwind 4, Radix primitives, Motion | Server components + file-based routing; accessible headless UI; purposeful animation |
| Auth | Clerk | Session/token management done right; backend verifies every token |
| API | Express 5 + TypeScript on Node 24 | Typed, small, explicit API layer — all business logic lives here |
| Database | PostgreSQL (Supabase) | Relational fits the domain (workspaces → events → photos/galleries); versioned SQL migrations |
| Object storage | Appwrite Storage | Binaries never touch the database or disk; UUID storage keys, server-side API key only |
| Tests | Vitest + Supertest | Real-Postgres integration tests; Clerk/Appwrite mocked at the boundary |
| CI | GitHub Actions (+ Turborepo) | Lint, type-check, tests against a real Postgres, production build on every PR |
| Monorepo | Turbo + Bun | One lockfile, cached builds across `apps/*` |

## Architecture

Three managed services, one rule each: **Clerk = identity, Supabase = metadata,
Appwrite = binaries.** All application logic lives in the Express API — Next.js
never talks to the database.

```
Browser
   │  (Clerk session token in Authorization header)
   ▼
Next.js 16 :3000 ──proxy.ts route protection──▶ Express 5 :4000
                                                 │ verifyToken (Clerk backend SDK)
                                                 ├─▶ Clerk      identity + invitations
                                                 ├─▶ PostgreSQL metadata (service role)
                                                 └─▶ Appwrite   photo binaries
```

Request flow for the customer gallery (no account):

```
GET /api/v1/public/galleries/<slug>            → published-gallery metadata (PIN screen)
POST /api/v1/public/galleries/<slug>/unlock    → { pin } verified server-side (timing-safe),
                                                 returns signed access token + photo list
GET /api/v1/public/galleries/<slug>/photos/:id?st=<token>
                                               → image bytes proxied from Appwrite
```

## Database design

Five versioned migrations (`supabase/migrations/`) produce:

```
workspaces ──< users ──< event_team_members >── events ──< photos
                │                                    │
                └──< invitations                     └──< galleries ──< gallery_photos >── photos
```

- **workspaces** — every user belongs to exactly one; the tenancy boundary
- **users** — `clerk_user_id` UNIQUE is the stable identity key; role enum `ADMIN | TEAM_MEMBER`
- **invitations** — pending invites, claimed on the invitee's first verified sign-in
- **events** — workspace-scoped; status `draft | active | completed`
- **event_team_members** — the assignment relationship; the ONLY way a member gains event access
- **photos** — metadata only (event, uploader, filename, `storage_file_id` UNIQUE, mime, size); binaries live in Appwrite
- **galleries** — event-scoped; unique slug, 6-digit PIN, `draft | published`
- **gallery_photos** — the curation join; every photo in a gallery belongs to the same event (enforced in SQL)

All tables are RLS-enabled with no anon policies — the backend connects with the
service role and enforces authorization in application code (workspace + role +
relationship checks on every request).

## API surface

All application endpoints live under `/api/v1`. Errors are always
`{ "error": "..." }` — internals never leak.

| Area | Endpoints | Access |
| --- | --- | --- |
| Health | `GET /health`, `GET /api/v1/health` | public |
| Identity | `GET /api/v1/me` | authenticated |
| Dashboard | `GET /api/v1/stats` — counts, 14-day upload series, activity feed | authed (role-scoped) |
| Team | `GET/POST /api/v1/team-members`, `POST …/invite`, `PATCH …/:id/role`, `DELETE …/:id` | ADMIN |
| Events | `GET/POST /api/v1/events`, `GET/PATCH/DELETE /api/v1/events/:id` | authed (writes ADMIN) |
| Event team | `GET/POST/DELETE /api/v1/events/:id/team-members` | read authed, writes ADMIN |
| Photos | `POST /api/v1/events/:eventId/photos` (multipart), `GET …/photos`, `DELETE /api/v1/photos/:photoId` | members upload to assigned events, delete ADMIN |
| Galleries | `POST /api/v1/events/:id/galleries`, `GET …/galleries`, `POST /api/v1/galleries/:id/publish`, `PATCH /api/v1/galleries/:id` (set PIN), `POST …/pin/regenerate` | ADMIN |
| Public | `GET /api/v1/public/galleries/:slug`, `POST …/unlock`, `GET …/photos/:photoId?st=` | public (PIN-gated) |

## Security model

- **Identity** only from verified Clerk bearer tokens (`verifyToken`); client-sent
  user IDs are never trusted — uploader/workspace/author fields are always
  server-derived (covered by tests that try to spoof them).
- **Authorization**: roles live in Postgres, re-read per request; team members
  need an `event_team_members` row per event; every read/write is workspace-scoped.
- **Uploads**: MIME allowlist (JPEG/PNG/WebP) enforced twice (multer filter + handler),
  25 MB cap, UUID storage keys — original filenames never touch the filesystem path.
- **Public gallery**: server-side timing-safe PIN comparison, in-memory rate limit
  (5 failures / slug+IP / 15 min), unpublished galleries are indistinguishable from
  missing ones (404 both).
- **Photo delivery**: customers never receive raw storage URLs. Photos stream
  through the backend behind an HMAC-signed, slug-bound, 12-hour access token
  minted at PIN unlock (`gallery-tokens.ts`).
- **Secrets** stay server-side; env is zod-validated at boot (the server refuses
  to start misconfigured); error responses are generic, details go to server logs.

## Local setup

Requires [Bun](https://bun.sh) and Node ≥ 24.

```sh
bun install

cp apps/frontend/.env.example apps/frontend/.env.local   # fill in
cp apps/backend/.env.example  apps/backend/.env.local    # fill in

bun run dev --filter=frontend   # Next.js on :3000
bun run dev --filter=backend    # Express on :4000 (tsx watch)
```

Create the schema either through the Supabase CLI or by applying the files in
`supabase/migrations/` in filename order against your Postgres.

## Environment variables

**Frontend** (`apps/frontend/.env.local`): `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`,
`NEXT_PUBLIC_API_URL`, plus the `NEXT_PUBLIC_CLERK_SIGN_*` route vars emitted by
`clerk init`.

**Backend** (`apps/backend/.env.local`): `DATABASE_URL`, `DATABASE_SSL_CA`,
`CLERK_SECRET_KEY`, `APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID`,
`APPWRITE_API_KEY`, `APPWRITE_BUCKET_ID`, and optional
`GALLERY_TOKEN_SECRET` (dedicated secret for signing gallery access tokens —
derived from the Clerk key if unset). Names only live in `.env.example`;
real values are never committed.

## Tests

```sh
bun run test   # = turbo test → backend vitest
```

60 integration tests across six suites (`api`, `authorization`, `photos`,
`galleries`, `public-gallery`, `stats`). Clerk verification and Appwrite are mocked at
the boundary; **Postgres is real** — authorization, tenancy, and workflows are
exercised end-to-end:

- authentication (401s), role gates (403s), cross-workspace isolation (404s)
- invitation → first-login provisioning (member claims pending row, self-signup → ADMIN)
- upload: assignment enforcement, uploader-spoof rejection, MIME rejection
- galleries: creation, cross-event photo rejection, publishing, PIN set/regenerate
- public surface: wrong/right PIN, rate-limit lockout, token-signed photo streaming,
  token-vs-gallery binding, draft-gallery non-existence

The DB-backed suites need `TEST_DATABASE_URL` (any empty Postgres with the
migrations applied); they are skipped when it's absent. CI provisions one
automatically.

## Deployment

Not deployed at the time of writing — the intended path:

- **Frontend** → Vercel (`NEXT_PUBLIC_*` vars are inlined at build time; set them
  in the project settings, never at runtime).
- **Backend** → Railway/Render/Fly (Node 24, `bun run build && node dist/server.js`,
  health check on `/health`; all env vars from the table above, `NODE_ENV=production`,
  `DATABASE_SSL_CA` pointing at the bundled Supabase CA cert).
- **Database** → Supabase (already cloud-hosted; apply migrations, use the
  transaction-pooler connection string).
- **Storage** → Appwrite Cloud (already configured).

Dockerfiles exist for both apps but are currently known-broken (backend ESM/CJS
mismatch, frontend build-time API URL) — see `AGENTS.md` before relying on them.

## Demo credentials

Provisioned on the live deployment at submission time (self-registering as admin
is part of the app's design; members join via email invitation):

- **Demo Admin** — created via `/register` (self-signups provision as ADMIN)
- **Demo Team Member** — invited from Team Management; accepts the Clerk email invite
- **Demo Gallery** — URL + 6-digit PIN published from the demo event

## Known limitations

- **Deployment pending** — the app is not yet live online (see [Deployment](#deployment)).
- Dashboard photo thumbnails still use direct Appwrite URLs for signed-in users
  (same-origin trust, UUID keys); the **public** surface is fully proxied. Bucket
  permissions are currently open — hardening them end-to-end is planned.
- PINs are stored in plaintext in Postgres; hashing requires a coordinated
  migration + deploy.
- The PIN rate limiter is in-memory (per process) — multi-instance deployments
  need a shared store.
- No thumbnails/resizing or pagination yet (photo lists are full-list fetches;
  fine at demo scale, flagged for scale work).
- The dashboard's upload chart shows the last 14 days only (no longer-range
  analytics); events detail, team, galleries and the customer gallery run on
  the real API.

## Repository notes

- `AGENTS.md` — the engineering rulebook (architecture invariants, conventions,
  security rules). Read before changing anything.
- `docs/AUDIT-2026-09-10.md` — a full-repository self-audit with findings and fixes.
- Conventional Commits; small, reviewed changes; CI gates every PR.
