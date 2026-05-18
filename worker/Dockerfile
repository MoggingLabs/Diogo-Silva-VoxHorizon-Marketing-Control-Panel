# syntax=docker/dockerfile:1.7
#
# VoxHorizon worker — multi-stage container build.
#
# Stage 1 (deps-builder) — produce a self-contained virtualenv from
# pyproject.toml + uv.lock using uv. Builder matches the runtime's
# Python minor (3.12, matching Playwright Noble) so the venv's
# bin/python3 resolves under the runtime base.
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
# Python 3.12 to match Playwright Noble runtime — a 3.11 venv would
# leave /opt/venv/bin/python3 as a broken symlink in stage 2.
FROM python:3.12-slim AS deps-builder

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

# Bring the prebuilt virtualenv across. The Playwright Noble base uses
# Python 3.12; stage 1 builds against python:3.12-slim, also 3.12 —
# different distros, identical minor. Both produce a venv whose
# bin/python is a SYMLINK to the *builder's* interpreter path
# (/usr/local/bin/python3.12 in slim). That path does not exist in the
# Noble runtime (system python is at /usr/bin/python3.12), so every
# venv script (uvicorn, pytest, etc.) whose shebang reads
# `#!/opt/venv/bin/python` would fail with "no such file or directory"
# at startup. Re-point the venv's interpreter symlinks at the Noble
# python so shebangs resolve.
COPY --from=deps-builder /opt/venv /opt/venv
RUN set -eux; \
    rm -f /opt/venv/bin/python /opt/venv/bin/python3 /opt/venv/bin/python3.12; \
    ln -s /usr/bin/python3.12 /opt/venv/bin/python; \
    ln -s /usr/bin/python3.12 /opt/venv/bin/python3; \
    ln -s /usr/bin/python3.12 /opt/venv/bin/python3.12; \
    /opt/venv/bin/python --version

WORKDIR /app

# Copy worker source last so source edits don't bust the deps layer.
# tests/, .env*, __pycache__/ and friends are excluded via .dockerignore.
COPY src ./src
COPY templates ./templates
COPY skills ./skills
COPY scripts ./scripts
COPY pyproject.toml ./pyproject.toml

# Create non-root user. The Playwright Noble base reserves uid 1000
# (pwuser) and now also 1001 (ubuntu) — pick 10001 to stay clear of any
# default-user slots the upstream image may grow into.
RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --create-home --home-dir /home/app --shell /usr/sbin/nologin app \
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
