# `pipeline-operator` — skill + deploy notes

The operator **playbook** for running the VoxHorizon image-ad pipeline like a
hired employee under a human manager. `SKILL.md` is the orchestration loop
across the 12 producing stages (read state → assert the dispatch envelope → do
the current stage's work in-context or via a specialist sub-agent → persist →
signal → narrate → stop); `mcp_server.py` publishes the worker tools as
**real, named MCP tools** the operator calls; `helper.py` is the thin
worker-tool client those tools delegate to (the single source of truth for
HTTP + validation).

This skill is loaded by the dedicated **operator** agent (its own container,
`hermes-agent-operator`), not Ekko. It pairs with `image-ad-authoring` (the
visual craft) and the per-stage operator skills (`copy-authoring`,
`creative-qa`, `ad-compliance`, `campaign-launch`, `campaign-monitor`), and is
gated by the `voxhorizon-approvals` plugin's `policy.operator.yaml`.

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
│                      #   pipeline_operator_render.
├── README.md          # this file
└── tests/
    ├── test_helper.py       # helper unit tests (mock httpx.Client + codex)
    ├── test_codex_render.py # codex renderer unit tests (faked Hermes plugin)
    └── test_mcp_server.py   # MCP server: registration + delegation (mock helper)
```

## Render backend (codex, $0)

`pipeline_operator_render` renders via the manager's ChatGPT/Codex
subscription. It generates each image IN-CONTAINER via Hermes' codex image-gen
plugin (the operator's ChatGPT/Codex OAuth → `gpt-image-2` through the Codex
Responses `image_generation` tool), then POSTs the bytes to the worker's
`POST /work/pipeline/tools/store_creative`. Cost: **$0** (`total_cost_usd: 0`,
recorded against `api="openai-codex"`).

There is no backend switch for the operator to set and no per-render routing
decision: the operator calls the render tool the same way every time, the spend
gate keys on the tool name, and the worker emits the same `pipeline_events`
(task_running/task_done), the same `cost_recorded` line, and the same
creative/iteration rows — so the dashboard, the auto-advance trigger, and the
cost aggregator behave identically every time.

## Deterministic render (the all-N-concepts contract)

The operator authors all N concepts ONCE, at brief time, and persists them via
`pipeline_operator_brief(pipeline_id, image_payload, concepts=[...])`. The
worker stores the plan on the brief payload (`payload.concepts`) and mirrors it
onto `config_draft.concepts`. The render then runs as a single DETERMINISTIC
pass with **no items**:

```python
pipeline_operator_brief(pipeline_id, payload, concepts=[...])     # persist plan
pipeline_operator_render(pipeline_id, "concept_preview")          # render ALL N
```

- `pipeline_operator_render(pipeline_id, kind)` with `items=None` reads the
  persisted plan and renders **every** concept (`concept_preview`) or **one
  final per pick** (`final`, `parent_creative_id` threaded automatically) in one
  pass — the LLM is never in the per-image loop and never re-authors prompts at
  render time, so a slow render can't collapse to "only one concept landed".
- It is **idempotent / resumable**: concepts already rendered (by version
  prefix — `v0.ideation` for previews, `v1` for finals) are skipped and reported
  in the result's `skipped` list, so a retry after an interruption renders only
  the remainder. This is the fix for pipelines that got stuck at 1/N concepts.
- The worker resolves the same persisted plan worker-side from the render call.
- Passing explicit `items` still works (back-compat / one-off / prompt refine).

The worker's `RenderItem.items` is optional; `BriefInput.concepts` is optional
(a brief may be authored before the concepts exist, then the render falls back
to whatever `items` the caller supplies).

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

Optional (codex render — all have working defaults):

- `HERMES_CODEX_PLUGIN_PATH` — path to the Hermes codex image-gen plugin
  `__init__.py`. Default `/opt/hermes/plugins/image_gen/openai-codex/__init__.py`.
- `HERMES_SRC_PATH` — Hermes source root put on `sys.path` so the plugin's
  `from agent...` imports resolve. Default `/opt/hermes`.
- `OPENAI_IMAGE_QUALITY` — `low` | `medium` | `high`. Default `high`.

The codex render requires the operator's ChatGPT/Codex OAuth credentials to be
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
