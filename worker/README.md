# VoxHorizon Worker

Local Python (FastAPI) worker that the Next.js app on Vercel talks to over Tailscale. Owns:

- Creative generation orchestration (image, video, b-roll) — lands in M2
- Audit runners (Meta Ads + Submagic) — lands in M4
- File ingest + Supabase Storage uploads — lands in M3
- Chat / Claude Code agent loop — lands in M2
- B-roll pool storage (`LocalBrollStore` is the v1 primary)

Communicates with the Vercel app exclusively via a shared-secret bearer token.

## Setup

```bash
uv sync
cp .env.example .env  # then fill in values
```

## Run

```bash
uv run uvicorn src.main:app --reload --port 8000
# or:
bash scripts/serve.sh
```

## Test

```bash
uv run pytest
```

## Running in Docker

For VPS deployment the worker is containerised. From the repo root:

```bash
docker compose up -d
```

That builds the multi-stage `worker/Dockerfile` (Python 3.11 + uv + Playwright Chromium + Node 22 + ffmpeg + yt-dlp + Hyperframes), runs uvicorn on `:8000`, exposes the port only on the compose network (Caddy fronts it — see [VPS-3 / #160](../../issues/160)), and reads env from `/opt/voxhorizon/.env` on the VPS.

Local one-off build:

```bash
./worker/scripts/docker-build.sh
```

Bigger picture (CI image push, Caddy reverse proxy, `.env` provisioning) is in [`ARCHITECTURE.md` § Containerization (VPS path)](../ARCHITECTURE.md#containerization-vps-path).

## Auth

Every route (including `/work/health`) requires:

```
Authorization: Bearer <WORKER_SHARED_SECRET>
```

The only exception is signed b-roll URLs at `/work/broll/{hash}?exp=…&sig=…`, which carry their own HMAC.

## Layout

```
worker/
  src/
    main.py             FastAPI app, CORS, router wiring, structlog
    auth.py             verify_secret dependency
    config.py           pydantic-settings model + get_settings()
    supabase_client.py  cached service-role Supabase admin client
    routes/
      health.py         GET /work/health
      creative.py       (stub — M2)
      audit.py          (stub — M4)
      upload.py         (stub — M3)
      chat.py           (stub — M2)
      broll.py          GET /work/broll/{hash} signed-URL streaming
    services/
      broll_store.py    BrollStore protocol + LocalBrollStore primary + SupabaseBrollStore stub
      claude_runner.py  (stub — M2)
      scripts_runner.py (stub — M2)
      storage.py        (stub — M2)
  tests/
  scripts/serve.sh
```
