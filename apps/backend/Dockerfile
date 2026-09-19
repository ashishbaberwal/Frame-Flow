# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Backend image — Express 5 + TypeScript API on :4000.
#
# The build context is the REPOSITORY ROOT, not this directory, because the
# dependency graph (bun.lock + workspace layout) lives at the root. Building
# from apps/backend alone silently drops the lockfile and breaks frozen
# installs. Build it like this:
#
#   docker build -f apps/backend/Dockerfile -t frameflow-backend .
#
# Run (backend env comes from apps/backend/.env.local at runtime, never baked
# into the image):
#
#   docker run --rm -p 4000:4000 --env-file apps/backend/.env.local \
#     -e NODE_ENV=production frameflow-backend
# ---------------------------------------------------------------------------

# Bun for install + compile; Node for runtime (matches engines.node >=24).
FROM oven/bun:1.3.14-alpine AS base
WORKDIR /app

# ---- Dependencies ----
# Copy every workspace manifest (root + each app) so `bun install` can resolve
# the whole workspace graph against the frozen lockfile. package.json files for
# workspaces must all be present or bun rewrites the lockfile and refuses
# --frozen-lockfile.
FROM base AS deps
COPY package.json bun.lock ./
COPY apps/backend/package.json ./apps/backend/
COPY apps/frontend/package.json ./apps/frontend/
RUN bun install --frozen-lockfile

# Production-only dependency tree for the runtime stage — keeps tsc, eslint,
# vitest and tsx out of the shipped image.
FROM base AS prod-deps
COPY package.json bun.lock ./
COPY apps/backend/package.json ./apps/backend/
COPY apps/frontend/package.json ./apps/frontend/
RUN bun install --frozen-lockfile --production

# ---- Build ----
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/backend/node_modules ./apps/backend/node_modules
COPY apps/backend/package.json apps/backend/tsconfig.json ./apps/backend/
COPY apps/backend/src ./apps/backend/src
WORKDIR /app/apps/backend
RUN bun run build

# ---- Runtime ----
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app/apps/backend

RUN addgroup -S app && adduser -S app -G app

# Compiled output is ESM (tsc emits `import ...` under module: NodeNext), so
# the package.json MUST keep "type": "module". Stripping it — as an earlier
# revision of this file did — makes Node throw ERR_REQUIRE_ESM at boot.
COPY --from=build /app/apps/backend/package.json ./package.json
COPY --from=build /app/apps/backend/dist ./dist
# db.ts reads this CA certificate whenever NODE_ENV=production and the database
# is not localhost; without it the pool cannot be built.
COPY apps/backend/prod-ca-2021.crt ./prod-ca-2021.crt

# Production dependency tree only — no dev toolchain (tsc, eslint, vitest, tsx).
#
# Bun does not copy packages into a workspace's node_modules; it installs them
# once into a root-level store (/app/node_modules/.bun/...) and leaves symlinks
# behind. Both halves are required or every import resolves to a dangling link:
#   /app/apps/backend/node_modules/<pkg> -> ../../../node_modules/.bun/<pkg>@<ver>/...
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=prod-deps /app/apps/backend/node_modules /app/apps/backend/node_modules

USER app
EXPOSE 4000

# Liveness via the app's own unauthenticated /health route.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form: node runs as PID 1 and receives SIGTERM directly, so the
# graceful-shutdown handler in server.ts actually fires.
CMD ["node", "dist/server.js"]
