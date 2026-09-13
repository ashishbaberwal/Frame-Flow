# AGENTS.md — FrameFlow (TrizenAI Photo Sharing Platform)

> **Read this file before doing anything else.** It defines the architecture,
> the rules that must not be broken, and the commands to verify your work.

## Project Overview

FrameFlow is a photography/event-team platform: admins create events and manage
team members, team members upload photos, and customers view published,
PIN-protected galleries through a shareable URL. Built as an internship
challenge, but engineered as a production-oriented system.

Three user types:
- **Admin / Lead** — creates events, manages the team, curates and publishes galleries
- **Team Member** — uploads photos to assigned events (no publishing rights)
- **Customer** — no account; opens a gallery URL + 6-digit PIN

## Repository Structure (Turborepo)

```
├── apps/
│   ├── frontend/          # Next.js 16 (App Router) + Tailwind 4 + shadcn-style UI
│   └── backend/           # Express 5 + TypeScript API (port 4000)
├── packages/              # Shared eslint-config / typescript-config / ui
├── supabase/
│   └── migrations/        # Version-controlled SQL migrations
├── turbo.json
└── package.json
```

- **Package manager: Bun** (`bun.lock` at root). Never add a second lockfile.
- Frontend runs on :3000, backend on :4000, bound to `0.0.0.0`.

## Non-Negotiable Architecture

```
Browser → Next.js (:3000) → Express (:4000)
                              ├── Clerk        → auth (identity, sessions)
                              ├── Supabase     → PostgreSQL (metadata only)
                              └── Appwrite     → photo/file storage (binary only)
```

| Concern        | Service   | Rules                                              |
| -------------- | --------- | -------------------------------------------------- |
| Auth           | Clerk     | No Supabase Auth, no NextAuth, no custom JWT       |
| Database       | Supabase  | PostgreSQL only — no Supabase Storage/Auth         |
| Files          | Appwrite  | Images only in Storage; metadata lives in Postgres |
| Backend        | Express   | Never move API logic into Next.js route handlers   |

**Never** replace a service because another tool is easier. Major architecture
changes require explicit human approval.

## Commands

```sh
bun install                       # install everything (workspaces)

bun run dev --filter=frontend     # Next.js dev server :3000
bun run dev --filter=backend      # Express dev server :4000 (tsx watch)

bun run lint                      # ESLint everywhere (turbo)
bun run check-types               # tsc --noEmit everywhere
bun run build                     # production build everywhere

cd apps/backend && bun run test   # vitest for the backend
```

### Docker

```sh
docker build -t frameflow-backend  apps/backend
docker build -t frameflow-frontend apps/frontend

# Run both with a shared network (backend env from apps/backend/.env.local):
docker network create ffnet
docker run -d --name ff-backend  --network ffnet \
  --env-file apps/backend/.env.local -e NODE_ENV=production -p 4000:4000 \
  frameflow-backend
docker run -d --name ff-frontend --network ffnet \
  -e NEXT_PUBLIC_API_URL=http://ff-backend:4000 -p 3000:3000 \
  frameflow-frontend
```

> **Known broken (do not trust this runbook yet):** `NEXT_PUBLIC_*` vars are
> inlined at *build* time, so `-e NEXT_PUBLIC_API_URL=...` at `docker run`
> cannot work — the frontend image needs it as a build arg. The backend image
> also has an open ESM/CJS mismatch in its Dockerfile. Fix the Dockerfiles
> before using Docker for anything real.

Only `frontend` and `backend` are Dockerized. Clerk, Supabase and Appwrite are
external managed services — never containerize them. Never hardcode
`localhost` into production Docker configuration.

## Environment Variables

Frontend (`apps/frontend/.env.local`, see `.env.example`):
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (browser-safe)
- `NEXT_PUBLIC_API_URL` (e.g. `http://localhost:4000`)
- `NEXT_PUBLIC_CLERK_SIGN_*` route vars (set by `clerk init`)

Backend (`apps/backend/.env.local`, see `.env.example`):
- `CLERK_SECRET_KEY` (server-only)
- `DATABASE_URL` (Supabase Postgres connection string)
- `APPWRITE_ENDPOINT` / `APPWRITE_PROJECT_ID` / `APPWRITE_API_KEY` / `APPWRITE_BUCKET_ID`

Rules:
- `.env.example` files contain **names only**, never real values.
- Never print, log or commit secrets. Never put server credentials into
  `NEXT_PUBLIC_*`. If a value is missing, ask — do not fabricate one.

## Clerk

- Application: `app_3J0j71EL3ptlhV9iywuqMGxXTPv` (FrameFlow), linked via `clerk init`.
- Frontend uses `@clerk/nextjs`; `ClerkProvider` sits **inside** `<body>`.
- Next.js 16 uses **`proxy.ts`** (not `middleware.ts`). The matcher must include
  `"/(api|trpc)(.*)"`; the `/__clerk/:path*` path is handled by Clerk's proxy layer.
- `/login` and `/register` are catch-all routes rendering `<SignIn>` / `<SignUp>`.
- Clerk Core 3: `SignedIn`/`SignedOut`/`Protect` are **removed** — use `<Show>`:
  `<Show when="signed-in">`, `<Show when="signed-out">`.
- Backend verifies identity with `verifyToken` from `@clerk/backend` (bearer
  token in the `Authorization` header). Never trust a client-sent `userId`.
- Middleware/helpers: `requireAuth`, `requireRole` (in `src/middleware/auth.ts`).
- `await auth()` — Next 15+ auth APIs are async.

## Supabase (PostgreSQL)

- Project ref: `vyaqbytpjmgvtawezcyu`.
- Migrations live in `supabase/migrations/` — version-controlled, reproducible.
- Applied via the Supabase MCP (`apply_migration`) or `supabase` CLI.
- Schema so far: `public.users` (clerk_user_id UNIQUE, role enum ADMIN/TEAM_MEMBER,
  updated_at trigger, RLS enabled — no anon policies; backend uses the service role).
- DB access layer: `apps/backend/src/lib/db.ts` (node-postgres pool, JIT user
  upsert from verified Clerk profiles).
- **Never** run destructive operations (db reset, DROP, data deletion) without
  explicit human confirmation.

## Appwrite (Storage)

- Project: `frameflow-edu` (region `syd`), bucket: `photos`
  (image extensions only, 25 MB max, encryption + antivirus + transformations on).
- API key: backend-only, scope limited to `buckets.read`, `files.read`, `files.write`.
- Client: `apps/backend/src/lib/storage.ts` (node-appwrite, server-side only).
- Binary images live in Appwrite; their metadata belongs in PostgreSQL.
  Never store binaries in Postgres, never persist production photos to disk.

## API Conventions

- All application APIs live under `/api/v1`.
- Endpoints so far:
  - `GET /health` — liveness (public)
  - `GET /api/v1/health` — liveness + DB check (public; 503 when degraded)
  - `GET /api/v1/me` — verified Clerk identity + app role (401 without token)
  - `GET /api/v1/stats` — dashboard aggregates; admins see the workspace, members only assigned events
  - `/api/v1/team-members` (+ `invite`, `:id/role`, `:id`) — workspace team management (ADMIN)
  - `/api/v1/events` CRUD — workspace-scoped; members see only assigned events (403)
  - `/api/v1/events/:id/team-members` — event assignment (ADMIN writes, members read)
  - `POST /api/v1/events/:eventId/photos`, `GET .../photos`, `DELETE /api/v1/photos/:photoId`
    — binaries to Appwrite, metadata to Postgres
  - `/api/v1/events/:id/galleries`, `POST /api/v1/galleries/:id/publish`, 
    `PATCH /api/v1/galleries/:id` (custom PIN), `POST …/pin/regenerate` — curation + publishing (ADMIN)
  - `GET /api/v1/public/galleries/:slug`, `POST /api/v1/public/galleries/:slug/unlock`,
    `GET /api/v1/public/galleries/:slug/photos/:photoId?st=` — customer surface
    (no Clerk auth; server-verified PIN, rate limited; photos proxied behind an
    HMAC-signed 12h token minted at unlock — `src/lib/gallery-tokens.ts`; drafts 404)
- Errors return `{ "error": "..." }`; internals never leak into responses.

## Frontend ↔ Backend

- All fetches go through `apps/frontend/src/lib/api/client.ts` using
  `NEXT_PUBLIC_API_URL`. Never scatter raw `fetch("http://localhost:4000/...")`
  calls through components.
- `use-current-user.ts` attaches the Clerk session token to API calls; the
  backend verifies it server-side.

## Security Rules (enforced now)

1. Identity only from verified Clerk tokens — never client-sent IDs.
2. Environment validated at boot; the server refuses to start misconfigured.
3. Secrets stay server-side and out of Git; no logging of key values.
4. TLS verification never disabled (`rejectUnauthorized: true` for remote DBs).
5. Safe errors: generic messages to clients, details to server logs.
6. Role checks read from Postgres (`requireRole`), not from the client.

## MCP / CLI Usage

- `clerk` CLI (v3.x): inspect apps, `env pull`, `doctor`. Logged-in account required.
- `supabase` CLI + Supabase MCP: migrations, table inspection, advisors.
- `appwrite` CLI + Appwrite MCP: projects, buckets, keys.
- CLIs/MCPs configure infrastructure; they never change the architecture.
- **Stop and ask before any destructive remote operation** (deletions, resets,
  bucket removal, production mutation). Remote resources are not disposable.

## Git Conventions

- Small Conventional Commits: `feat:`, `fix:`, `chore:`, `test:`, `docs:`.
- Inspect `git status && git diff` before every commit — no secrets, no
  generated files, no unrelated modifications, no frontend redesigns.
- Never create fake commits; never force-push.

## Definition of Done (per change)

Run before finishing: `bun run lint && bun run check-types && bun run build`,
plus `bun run test` in `apps/backend` when backend code changed. Report
failures honestly — never claim green when a check failed.

## Demo Account Setup (same real auth flow — no shortcuts)

Demo accounts use the standard Clerk → Postgres flow. No hardcoded emails, no
bypassed authorization, no fake endpoints.

**One-time Clerk Dashboard action (required for invitations):** the Clerk
backend SDK sends invitation emails through Clerk's default email provider in
development. If invites don't arrive, check Clerk Dashboard → your app →
**Users → Invitations** (the invitation exists there even if email delivery
is delayed; in dev you can copy the invitation link and open it directly).

Setup steps:
1. **Demo Admin:** sign up through the app (`/register`) and sign in once —
   self-registered accounts provision as **ADMIN** automatically (product
   policy: role defaults to ADMIN for self-signups; invitations stamp
   `role: 'TEAM_MEMBER'` into Clerk publicMetadata so invitees provision as
   TEAM_MEMBER). No manual SQL is needed anymore.
2. **Demo Team Member:** from the Admin's Team Management page, click
   *Invite member*, enter name + email. The invitee accepts the Clerk email
   invite, signs in, and their verified Clerk identity claims the pending
   Postgres row with role TEAM_MEMBER.
3. **Assign to an event:** Admin opens an event → Team tab → *Assign member*.
4. Verify: the member sees only assigned events; requests to unassigned
   event IDs return 403.

Identity mapping: `users.clerk_user_id` is the stable key. Pending invites
use a `pending:<email>` placeholder that never collides with a real Clerk ID.

## What NOT To Build Yet

The core loop (events → uploads → curation → publish → customer PIN view)
is live end to end. Deliberately still open — do not build ahead of the plan:

- ZIP/bulk download of a whole gallery (per-photo download works today)
- Thumbnails / Appwrite transformations in the gallery grid, pagination
- Gallery expiry + unpublish (the publish endpoint has no reverse yet)
- PIN hashing at rest (PINs are plaintext in `galleries.pin`; changing this
  needs a coordinated migration + deploy — ask before touching remote DBs)
- Redis/Postgres-backed rate limiting if the API ever runs multi-instance
  (the PIN limiter in `src/lib/rate-limit.ts` is in-memory, per process)
- Dashboard photos still render direct Appwrite view URLs for signed-in
  users; the public gallery is fully proxied behind signed tokens. Making
  the bucket private end-to-end is the remaining hardening step.
