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
| Public galleries | `/public/galleries/:slug/*`                 | Public, PIN/token protected                        |

Errors use a consistent response shape:

```json
{ "error": "A safe user-facing message" }
```

Internal error details are logged server-side and are not returned to clients.

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
- Gallery PIN attempts are rate-limited per gallery and IP address.
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
`http://localhost:4000`.

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
limiting, and signed public gallery access.

```sh
bun run lint
bun run check-types
bun run test
bun run build
```

The database-backed integration suites require `TEST_DATABASE_URL` with the
migrations applied. GitHub Actions provisions PostgreSQL, applies migrations,
and runs the verification pipeline on pushes to `main` and pull requests.

## Known limitations

- Production Clerk invitation emails require a verified sending domain; the
  manual pending-member flow is available without one.
- Gallery PINs are currently stored as plaintext in PostgreSQL.
- Rate limiting is in-memory and therefore per backend process.
- Authenticated dashboard previews use Appwrite view URLs; public gallery
  photos use the signed backend proxy.
- Photo grids load the complete event set; thumbnails and pagination are not
  implemented yet.
- Bulk ZIP downloads, gallery expiry, and gallery unpublish are not included.

## License

This repository was created as an internship challenge submission.
