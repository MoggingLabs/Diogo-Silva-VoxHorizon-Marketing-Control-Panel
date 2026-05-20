# `pipeline-operator` — skill + deploy notes

The operator **playbook** for running the VoxHorizon image-ad pipeline like a
hired employee under a human manager. `SKILL.md` is the operating loop (read
state → do the current stage's work → narrate → stop); `helper.py` is the thin
worker-tool client.

This skill is loaded by the dedicated **operator** agent (its own container,
`hermes-agent-operator`), not Ekko. It pairs with `image-ad-authoring` (the
creative craft) and is gated by the `voxhorizon-approvals` plugin's
`policy.operator.yaml`.

## Layout

```
ekko-skills/pipeline-operator/
├── SKILL.md           # the operator playbook (per-stage behavior, narration,
│                      #   the spend-gate discipline)
├── helper.py          # worker-tool client:
│                      #   pipeline_operator_read   (GET state; allowlisted)
│                      #   pipeline_operator_brief  (POST brief; free write)
│                      #   pipeline_operator_render (POST render; SPEND-gated)
├── README.md          # this file
└── tests/
    └── test_helper.py # pytest unit tests (mock httpx.Client)
```

## Tool-name surface (the gating contract)

The approval plugin gates **by tool name**. The operator's three capabilities
are exposed under distinct, stable entrypoint names so the operator policy can
reference them one-for-one:

| Entrypoint                 | Worker endpoint                    | Gate (policy.operator.yaml)   |
| -------------------------- | ---------------------------------- | ----------------------------- |
| `pipeline_operator_read`   | `GET  /work/pipeline/tools/{id}`   | **allowlist** (no prompt)     |
| `pipeline_operator_brief`  | `POST /work/pipeline/tools/brief`  | allowlist (free write)        |
| `pipeline_operator_render` | `POST /work/pipeline/tools/render` | **requires approval (spend)** |

`get_pipeline` / `post_brief` / `post_render` are readable aliases of the
above. **Do not rename `pipeline_operator_render`** without updating
`ekko-plugins/voxhorizon_approvals/policy.operator.yaml` — the spend gate keys
on this exact name.

## Required environment variables

Set in the operator container's `.env`:

- `WORKER_BASE_URL` — e.g. `http://worker:8000`
- `WORKER_SHARED_SECRET` — the bearer secret the worker's `verify_secret`
  checks (same value the worker reads from its own environment)

Both are read lazily on the first call; missing/empty values raise
`PipelineOperatorError` immediately.

## Local tests

The skill's only non-stdlib runtime dependency is `httpx`.

```bash
cd ekko-skills/pipeline-operator
python3 -m venv .venv
.venv/bin/pip install httpx pytest
.venv/bin/pytest tests/ -v
```

The tests mock `httpx.Client` so no worker and no secrets are required.

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
