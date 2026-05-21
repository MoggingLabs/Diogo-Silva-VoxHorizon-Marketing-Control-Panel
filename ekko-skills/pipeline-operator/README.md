# `pipeline-operator` — skill + deploy notes

The operator **playbook** for running the VoxHorizon image-ad pipeline like a
hired employee under a human manager. `SKILL.md` is the operating loop (read
state → do the current stage's work → narrate → stop); `mcp_server.py`
publishes the three worker tools as **real, named MCP tools** the operator
calls; `helper.py` is the thin worker-tool client those tools delegate to (the
single source of truth for HTTP + validation).

This skill is loaded by the dedicated **operator** agent (its own container,
`hermes-agent-operator`), not Ekko. It pairs with `image-ad-authoring` (the
creative craft) and is gated by the `voxhorizon-approvals` plugin's
`policy.operator.yaml`.

## Layout

```
ekko-skills/pipeline-operator/
├── SKILL.md           # the operator playbook (per-stage behavior, narration,
│                      #   the spend-gate discipline)
├── mcp_server.py      # stdio MCP server: publishes the four tools below and
│                      #   delegates each to helper.py (no logic of its own)
├── helper.py          # worker-tool client (single source of truth):
│                      #   pipeline_operator_read         (GET state; allowlisted)
│                      #   pipeline_operator_client_read  (GET client; allowlisted)
│                      #   pipeline_operator_brief        (POST brief; free write)
│                      #   pipeline_operator_render       (render; SPEND-gated)
├── codex_render.py    # in-container codex image renderer (the manager's
│                      #   ChatGPT/Codex subscription → gpt-image-2; $0). Backs
│                      #   the default RENDER_BACKEND=openai-codex path.
├── README.md          # this file
└── tests/
    ├── test_helper.py       # helper unit tests (mock httpx.Client + codex)
    ├── test_codex_render.py # codex renderer unit tests (faked Hermes plugin)
    └── test_mcp_server.py   # MCP server: registration + delegation (mock helper)
```

## Render backend (codex vs Kie)

`pipeline_operator_render` is backend-selectable via the operator container's
`RENDER_BACKEND` env (the tool name + the spend gate are UNCHANGED — the gate
keys on the tool name regardless of backend):

| `RENDER_BACKEND`        | How it renders                                                                                 | Cost |
| ----------------------- | ---------------------------------------------------------------------------------------------- | ---- |
| `openai-codex` (default) | Generates each image IN-CONTAINER via Hermes' codex image-gen plugin (the operator's ChatGPT/Codex OAuth → `gpt-image-2` through the Codex Responses `image_generation` tool), then POSTs the bytes to the worker's `POST /work/pipeline/tools/store_creative`. | **$0** |
| `kie`                   | POSTs to the worker's `POST /work/pipeline/tools/render` (the legacy paid Kie path).            | paid |

Both backends make the worker emit the SAME `pipeline_events`
(task_running/task_done), the same cost line (`cost_recorded`; subtotal 0 for
codex, against `api="openai-codex"`), and the same creative/iteration rows — so
the dashboard, the auto-advance trigger, and the cost aggregator behave
identically. Only the bill changes.

**True 9:16:** finals' 9:16 renders are a TRUE 9:16 (864x1536), not 2:3. The
codex renderer calls the plugin's lower-level helper with an explicit pixel
`size="864x1536"` (gpt-image-2 supports up to 3:1; the Codex backend honors the
non-canonical size — the OpenAI SDK emits a harmless serialization warning).
**No VPS plugin edit and no post-crop are required** — confirmed on the VPS.

## Tool-name surface (the gating contract)

The approval plugin gates **by tool name**. The operator's three capabilities
are published as MCP tools (by `mcp_server.py`) under distinct, stable names so
the operator policy can reference them one-for-one:

| MCP tool                   | Worker endpoint                    | Gate (policy.operator.yaml)   |
| -------------------------- | ---------------------------------- | ----------------------------- |
| `pipeline_operator_read`   | `GET  /work/pipeline/tools/{id}`   | **allowlist** (no prompt)     |
| `pipeline_operator_brief`  | `POST /work/pipeline/tools/brief`  | allowlist (free write)        |
| `pipeline_operator_render` | `POST /work/pipeline/tools/render` | **requires approval (spend)** |

Hermes presents these to the gate as `mcp_<server>_<tool>` with single
underscores — e.g. `mcp_pipeline_operator_pipeline_operator_render` — and the
overlay keys on that exact full name (no fuzzy matching). **Do not rename
`pipeline_operator_render`** (or the MCP server name) without updating
`ekko-plugins/voxhorizon_approvals/policy.operator.yaml` — the spend gate keys
on this exact name.

## Required environment variables

Set in the operator container's `.env`:

- `WORKER_BASE_URL` — e.g. `http://worker:8000`
- `WORKER_SHARED_SECRET` — the bearer secret the worker's `verify_secret`
  checks (same value the worker reads from its own environment)

Both are read lazily on the first call; missing/empty values raise
`PipelineOperatorError` immediately.

Optional (codex backend — all have working defaults):

- `RENDER_BACKEND` — `openai-codex` (default) | `kie`. Unset = `openai-codex`.
- `HERMES_CODEX_PLUGIN_PATH` — path to the Hermes codex image-gen plugin
  `__init__.py`. Default `/opt/hermes/plugins/image_gen/openai-codex/__init__.py`.
- `HERMES_SRC_PATH` — Hermes source root put on `sys.path` so the plugin's
  `from agent...` imports resolve. Default `/opt/hermes`.
- `OPENAI_IMAGE_QUALITY` — `low` | `medium` | `high`. Default `high`.

The codex backend requires the operator's ChatGPT/Codex OAuth credentials to be
present in the container (`auth.json` under `$HERMES_HOME`); the renderer reads
them through Hermes' canonical token reader. No `OPENAI_API_KEY` is needed.

## Local tests

`helper.py`'s only non-stdlib runtime dependency is `httpx`; `mcp_server.py`
also needs the official `mcp` SDK. The MCP server test is import-guarded — it
skips if `mcp` is not installed, so the helper tests run with `httpx` alone.

```bash
cd ekko-skills/pipeline-operator
python3 -m venv .venv
.venv/bin/pip install httpx mcp pytest
.venv/bin/pytest tests/ -v
```

The tests mock `httpx.Client` (helper) and the helper functions (MCP server),
so no worker and no secrets are required.

## VPS deployment

Copy + restart, same as the sibling skills. The operator container
bind-mounts the skills directory.

1. Sync into the operator's skills directory:

   ```bash
   rsync -a --delete \
     ekko-skills/pipeline-operator/ \
     vps:/opt/data/skills-operator/pipeline-operator/
   ```

   Also deploy `image-ad-authoring` alongside it — this skill calls it.

2. Set `WORKER_BASE_URL` and `WORKER_SHARED_SECRET` in the operator
   container's env file.

3. Ensure the `voxhorizon-approvals` plugin in the operator container uses
   the **operator** policy (`policy.operator.yaml` dropped as its
   `policy.yaml`) so `pipeline_operator_render` is spend-gated and
   `pipeline_operator_read` is allowlisted. See the plugin README's
   "Operator policy profile" section.

4. Restart the operator agent:

   ```bash
   ssh vps 'docker restart hermes-agent-operator'
   ```

5. Verify it registered:

   ```bash
   ssh vps 'docker exec hermes-agent-operator hermes skills list \
     | grep pipeline-operator'
   ```

## Mirror to the `silva-1337/ekko` repo

Mirror the directory into the agent image's `skills/` so a base-image rebuild
bakes it in — follow-up after this lands, out of scope here.

## Pairs with

- `image-ad-authoring` — the creative craft this skill drives.
- `voxhorizon-approvals` (`policy.operator.yaml`) — the spend gate.
- Worker Wave-A endpoints under `/work/pipeline/tools/`.
