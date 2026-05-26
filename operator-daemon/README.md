# voxhorizon-operator-daemon

A sidecar container that owns the `work_item` queue's `operator_dispatch`
kind: it claims rows from the worker's REST surface, runs `hermes chat`
inside the colocated `hermes-agent-operator` container via the Docker
socket, and PATCHes the row closed (complete on success, fail with a
classified `error_kind` on every failure mode).

## Why a sidecar and not a CMD swap

The live `hermes-agent-operator` container runs the upstream Hermes
framework image (`hermes-lua:src`); the user wants it left as-is. The
silent-failure plan's "replace the CMD with `python -m voxhorizon_daemon`"
cannot run against an image we do not own. The structural goals (loud
container-down signal on auth/skill failure, single source of truth for
dispatch state, no fire-and-forget) all hold for a sidecar so long as the
sidecar OWNS the work_item lifecycle: write the row before invoking
hermes, classify exec failures, record every transition. The daemon
performs its startup self-test BEFORE marking `work_item_consumers.status
= 'live'`; a failed auth probe leaves the consumer `down` and the Docker
healthcheck red.

See `memory: operator-image-constraint` for the constraint.

## Package layout

```
voxhorizon_daemon/
  __init__.py       # version + package exports
  __main__.py       # python -m voxhorizon_daemon entry
  settings.py       # pydantic-settings model
  types.py          # work_item / consumer payload shapes
  queue_client.py   # async HTTP client for the worker work_queue surface
  hermes_exec.py    # docker SDK wrapper: auth_probe + chat + error classify
  startup.py        # pure-function startup self-test
  daemon.py         # Daemon class: drain loop + heartbeats + SIGTERM
  healthz.py        # tiny FastAPI sidecar on :9001 for Docker healthcheck
```

## Local dev

```sh
cd operator-daemon
uv venv
uv pip install -e .
```

Run the daemon (env-driven):

```sh
WORKER_URL=http://localhost:8000 \
WORKER_SHARED_SECRET=devsecret \
CONSUMER_ID=operator-daemon-dev \
  python -m voxhorizon_daemon
```

Tests:

```sh
uv run pytest
```

## What this PR ships

- The Python package + Dockerfile + tests above
- A new CI job `operator-daemon (pytest)` in `.github/workflows/ci.yml`

It deliberately does NOT touch `docker-compose.yml`, the deploy-stack
workflow, the worker, or the web app. Those are PR-3 cutover concerns.
This is a self-contained directory the build chain has not yet picked up.
