# syntax=docker/dockerfile:1.7
#
# VoxHorizon worker — multi-stage container build.
#
# Stage 1 (deps-builder) — produce a self-contained virtualenv from
# pyproject.toml + uv.lock using uv. Builder stays on python:3.11-slim
# so the lockfile resolves against the runtime's interpreter major.minor.
#
# Stage 2 (runtime) — start from the Playwright Python base which
# already has Chromium + every system library it needs preinstalled.
# Add Node 22 (Hyperframes CLI), ffmpeg, yt-dlp, curl, and the prebuilt
# .venv from stage 1. Run uvicorn on :8000 as a non-root user.
#
# Final image stays under 2 GB. NEVER bake secrets in. WORKER_SHARED_SECRET
# is read from env at runtime (compose env_file mount).

# -----------------------------------------------------------------------------
# Stage 1 — deps-builder
# -----------------------------------------------------------------------------
FROM python:3.11-slim AS deps-builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv

# uv is a single static binary; install it without leaving curl behind
# beyond what slim already ships. We pin the install script to its
# stable channel — the lockfile pins the actual resolver behavior.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && curl -LsSf https://astral.sh/uv/install.sh | sh \
    && mv /root/.local/bin/uv /usr/local/bin/uv

WORKDIR /build

# Copy lockfile + pyproject first so dependency layer caches across
# source-only edits.
COPY pyproject.toml uv.lock ./

# Frozen sync → no resolver re-pass, no dev extras. Targets /opt/venv
# (via UV_PROJECT_ENVIRONMENT) so stage 2 can copy a flat tree.
RUN uv sync --frozen --no-dev --no-install-project

# -----------------------------------------------------------------------------
# Stage 2 — runtime
# -----------------------------------------------------------------------------
# Playwright base ships Chromium + every system library it needs
# preinstalled, on Ubuntu Noble (24.04). Tag pinned to a recent stable.
FROM mcr.microsoft.com/playwright/python:v1.50.0-noble AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:${PATH}" \
    VIRTUAL_ENV=/opt/venv \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production

# System packages we need on top of the Playwright base:
#   - ffmpeg          → video compose + audio remux
#   - yt-dlp          → external source ingest
#   - curl            → HEALTHCHECK probe (should already be present, install for safety)
#   - ca-certificates → TLS roots for external APIs
# Node 22 comes from NodeSource because Noble ships Node 18 / 20.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gnupg \
        ffmpeg \
        yt-dlp; \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -; \
    apt-get install -y --no-install-recommends nodejs; \
    apt-get purge -y --auto-remove gnupg; \
    rm -rf /var/lib/apt/lists/*; \
    npm install -g hyperframes@latest; \
    npm cache clean --force

# Bring the prebuilt virtualenv across. The Playwright base uses Python
# 3.12; the venv stage 1 produces also targets 3.11 — we mount the venv
# at /opt/venv and force its interpreter onto PATH via VIRTUAL_ENV +
# /opt/venv/bin shadowing /usr/bin/python3. The interpreter shim inside
# the venv is the canonical entrypoint.
COPY --from=deps-builder /opt/venv /opt/venv

WORKDIR /app

# Copy worker source last so source edits don't bust the deps layer.
# tests/, .env*, __pycache__/ and friends are excluded via .dockerignore.
COPY src ./src
COPY templates ./templates
COPY skills ./skills
COPY scripts ./scripts
COPY pyproject.toml ./pyproject.toml

# Create non-root user. The Playwright base ships its own `pwuser`
# (uid 1000) — we use a fresh `app` uid to keep the boundary explicit.
RUN groupadd --system --gid 1001 app \
    && useradd --system --uid 1001 --gid app --create-home --home-dir /home/app --shell /usr/sbin/nologin app \
    && mkdir -p /app/storage \
    && chown -R app:app /app /opt/venv /home/app

USER app

EXPOSE 8000

# Healthcheck hits the authed /work/health route with the bearer secret
# from env at runtime. Fails fast on connect refused or non-2xx.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -fsS -H "Authorization: Bearer ${WORKER_SHARED_SECRET}" \
        http://localhost:8000/work/health || exit 1

# Use the venv's uvicorn directly — PATH already prepends /opt/venv/bin.
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000"]
