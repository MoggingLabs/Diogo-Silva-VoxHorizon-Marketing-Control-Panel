# syntax=docker/dockerfile:1.7
#
# VoxHorizon web (Next.js) — multi-stage container build.
#
# Build context: REPO ROOT (`.`). The compose service uses
#   build: { context: ., dockerfile: web/Dockerfile }
# so `COPY . .` here means the whole repo, gated by the root
# .dockerignore which excludes worker/, node_modules/, etc.
#
# Stage 1 (deps)     — install pnpm + production+dev node_modules.
#                       Source layer is just package.json + pnpm-lock,
#                       so it caches across application-source edits.
# Stage 2 (builder)  — bring deps over, copy source, accept the
#                       NEXT_PUBLIC_* build args, run `pnpm build`. The
#                       Next.js config (output: "standalone") emits a
#                       self-contained server bundle at
#                       .next/standalone/server.js with a pruned
#                       node_modules tree.
# Stage 3 (runtime)  — minimal slim image with curl (HEALTHCHECK only),
#                       non-root user, just the standalone bundle +
#                       static assets. ~150 MB final size.
#
# NEVER bake secrets in. Only NEXT_PUBLIC_* values cross the ARG/ENV
# boundary at build time — those are inlined into the client bundle by
# `next build` and are PUBLIC by design. Server-only secrets
# (SUPABASE_SERVICE_ROLE_KEY, WORKER_SHARED_SECRET, VAPID_PRIVATE_KEY,
# RESEND_API_KEY) are read from the env at runtime via compose env_file.

# -----------------------------------------------------------------------------
# Stage 1 — deps
# -----------------------------------------------------------------------------
FROM node:22-slim AS deps
WORKDIR /app

# Match the project's pinned pnpm exactly (package.json#packageManager).
# corepack ships with Node 22 — `prepare --activate` cures the
# "Cannot find matching keyid" failure modes for older Node images.
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Lockfile-only layer so source edits don't bust the install cache.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# -----------------------------------------------------------------------------
# Stage 2 — builder
# -----------------------------------------------------------------------------
FROM node:22-slim AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY --from=deps /app/node_modules ./node_modules

# Repo root is the build context — .dockerignore at the repo root
# trims worker/, infra/, tests/, .env*, .git/, etc. before this step.
COPY . .

# NEXT_PUBLIC_* vars are inlined into the client bundle at build time.
# Rotating any of these requires a CI rebuild + redeploy, NOT just a
# container restart. CI passes them via `--build-arg` (see VPS-10).
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_VAPID_PUBLIC_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_VAPID_PUBLIC_KEY=$NEXT_PUBLIC_VAPID_PUBLIC_KEY \
    NEXT_TELEMETRY_DISABLED=1

RUN pnpm build

# -----------------------------------------------------------------------------
# Stage 3 — runtime
# -----------------------------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

# curl is only here for HEALTHCHECK; rm -rf the apt lists after to
# keep the layer small. Create a dedicated `app` system user so the
# runtime never executes as root.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 1001 app \
    && useradd --system --uid 1001 --gid app --create-home --home-dir /home/app --shell /usr/sbin/nologin app \
    && chown -R app:app /app /home/app

# The standalone bundle is self-contained: it copies its own server.js,
# the node_modules subset it actually imports, and a minimal .next
# tree. Static assets and any public/ folder are NOT included by the
# standalone tracer — they have to be copied in alongside.
COPY --from=builder --chown=app:app /app/.next/standalone ./
COPY --from=builder --chown=app:app /app/.next/static ./.next/static

# public/ is optional in this repo today — no static images, manifest,
# or service worker live there yet (see lib/notifications.ts comment).
# Create an empty dir so the runtime can still resolve /public/* without
# the COPY step breaking the build when the folder is absent. The dir
# is owned by the non-root user so any future static drop-ins picked
# up by a later build keep the right perms.
RUN mkdir -p /app/public && chown app:app /app/public

USER app

EXPOSE 3000

# Hit the Next.js root (returns 200 once the app router is ready).
# `--start-period=30s` gives the standalone server time to boot before
# the first probe; subsequent probes run every 30s.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -fsS http://localhost:3000/ || exit 1

# server.js was emitted at .next/standalone/server.js in the builder
# and now lives at /app/server.js. It honors PORT + HOSTNAME from env.
CMD ["node", "server.js"]
