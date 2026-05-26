# syntax=docker/dockerfile:1.7
#
# voxhorizon-operator-daemon — sidecar container that owns the work_item
# queue's operator_dispatch kind. Mounts /var/run/docker.sock at deploy
# time so it can ``docker exec`` into the hermes-agent-operator container.
#
# Two-stage build: deps in stage 1 via uv, runtime in stage 2 (slim).
#
# NEVER bake secrets in. WORKER_SHARED_SECRET is read from env at runtime
# (compose env_file or secrets mount).

# -----------------------------------------------------------------------------
# Stage 1 — deps-builder
# -----------------------------------------------------------------------------
# Python 3.12 matches the worker, the package's requires-python, and the
# slim base used in stage 2 so the venv's bin/python symlink stays valid.
FROM python:3.12-slim AS deps-builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv

# uv is a single static binary. Install via the upstream script; pin the
# stable channel (the lockfile pins the resolver behaviour).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && curl -LsSf https://astral.sh/uv/install.sh | sh \
    && mv /root/.local/bin/uv /usr/local/bin/uv

WORKDIR /build

# Copy lockfile + pyproject first so the dependency layer caches across
# source-only edits.
COPY pyproject.toml ./
# uv.lock is generated at first install; we tolerate its absence so the
# initial build still works even before a lockfile lands.
COPY uv.lock* ./

# Frozen sync when a lockfile is present; otherwise resolve normally. Either
# way, no dev extras and no project install (we copy source in stage 2).
RUN if [ -f uv.lock ]; then \
      uv sync --frozen --no-dev --no-install-project ; \
    else \
      uv sync --no-dev --no-install-project ; \
    fi

# -----------------------------------------------------------------------------
# Stage 2 — runtime
# -----------------------------------------------------------------------------
# Slim runtime: we only need Python, curl (for the healthcheck probe), and
# the docker SDK's transport (HTTP-over-unix; no extra binaries needed).
FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:${PATH}" \
    VIRTUAL_ENV=/opt/venv

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Bring the pre-built virtualenv across. The slim base uses the same
# python3.12 the builder did, so the venv's symlinks resolve at /usr/local
# in BOTH stages — no symlink fix-up needed (unlike the worker, which
# crosses python:3.12-slim -> playwright-noble and has to re-link).
COPY --from=deps-builder /opt/venv /opt/venv

WORKDIR /app

# Copy package source last so source-only edits do not bust the deps layer.
COPY voxhorizon_daemon ./voxhorizon_daemon
COPY pyproject.toml ./pyproject.toml
COPY README.md ./README.md

# Non-root user. uid/gid are unprivileged; the docker-socket mount on the
# host has to grant access via group_add at compose time (the daemon does
# not chown the socket).
RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --create-home --home-dir /home/app --shell /usr/sbin/nologin app \
    && chown -R app:app /app /opt/venv /home/app

USER app:app

# /healthz lives on this port. Docker's healthcheck probes it; deploy-stack
# may also expose it on the host for the dashboard's daemon-health endpoint.
EXPOSE 9001

# The healthcheck IS the loud failure signal the design relies on. A failed
# startup self-test (auth_expired, hermes_container missing) leaves the
# daemon with consumer_status='down' and last_consumer_heartbeat=0; both
# states return 503 from /healthz, the orchestrator marks the container
# unhealthy, and the dashboard's DaemonHealthBadge flips red.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -fsS http://localhost:9001/healthz || exit 1

CMD ["python", "-m", "voxhorizon_daemon"]
