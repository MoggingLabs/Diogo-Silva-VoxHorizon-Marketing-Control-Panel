# voxhorizon-approvals

Hermes/Ekko plugin that gates every tool call against the VoxHorizon
dashboard. Safe tools (allowlist) and cached approvals run in-process at
sub-millisecond cost; sensitive tools wait for the operator's decision
via the VoxHorizon worker.

## Hot path

```
agent loop ──► pre_tool_call ─┬─ allowlist? ───► allow (<50us)
                              ├─ cached?    ───► allow (<5us)
                              └─ HTTP POST  ───► worker long-poll (3-30s typical)
```

Every decision is appended to `/opt/data/logs/voxhorizon-approvals.jsonl`.

## Install

Copy this directory into the Hermes plugins folder and add it to the
runtime config.

1. Copy the plugin tree to the VPS. The on-disk directory uses the
   underscore form (`voxhorizon_approvals`) so Python can import it
   directly during testing; Hermes reads the canonical plugin name
   from `plugin.yaml` (`voxhorizon-approvals`, with a hyphen), so the
   destination directory name doesn't have to match `plugins.enabled`.

   ```bash
   rsync -a ekko-plugins/voxhorizon_approvals/ \
     vps:/opt/data/home/.hermes/plugins/voxhorizon_approvals/
   ```

2. Set the env vars in `/docker/hermes-agent-t4k4/.env` (same values
   the worker reads from its own environment):

   ```env
   VOXHORIZON_APPROVAL_WORKER_URL=http://worker:8000
   VOXHORIZON_APPROVAL_TOKEN=<shared secret with the worker>
   ```

3. Enable the plugin in `/opt/data/config.yaml`:

   ```yaml
   plugins:
     enabled:
       - voxhorizon-approvals
   ```

4. Restart Ekko:

   ```bash
   docker restart hermes-agent-ekko
   ```

5. Validate:

   ```bash
   docker exec hermes-agent-ekko hermes plugins list
   # Expect: voxhorizon-approvals … enabled
   ```

## Policy overrides

`policy.yaml` next to this file is reloaded on mtime change. Three keys:

| Key                       | Effect                                          |
| ------------------------- | ----------------------------------------------- |
| `allowlist`               | Adds tools to the in-code ALLOWLIST             |
| `extra_requires_approval` | Adds tools to the in-code REQUIRES_APPROVAL set |
| `blocklist`               | Tools that are always rejected without operator |

In-code defaults always win over a softening override — for example,
adding `shell_command` to `allowlist` does **not** disable the
`ALWAYS_ASK_PATTERNS` check for `rm -rf` / `dd` / `mkfs`. That
defense-in-depth is intentional: it means a malicious override of
`policy.yaml` still can't smuggle a destructive command past the gate.

The overlay loader lives in `policy_overlay.py` (`load_overlay(path)` →
`PolicyOverlay.evaluate(...)`, an `evaluate`-compatible decision function that
applies the three keys with the precedence above). No PyYAML dependency is
required — the loader parses the policy-file YAML subset itself (and uses
PyYAML only if it happens to be installed).

### Opt-in wiring (`VOXHORIZON_APPROVAL_POLICY_PATH`)

The overlay is **opt-in and env-gated** so Ekko is unchanged by default:

| `VOXHORIZON_APPROVAL_POLICY_PATH`  | Decision function used                          |
| ---------------------------------- | ----------------------------------------------- |
| unset / empty / non-existent path  | plain in-code `policy.evaluate` (Ekko-safe)     |
| set to an **existing** policy file | `load_overlay(path).evaluate` (overlay applied) |

`register()` resolves this once at load time, so the hot path pays no per-call
cost. With the env unset the hook is byte-identical to the pre-overlay plugin;
Ekko ships an empty `policy.yaml` and does not set the env, so even if it did
opt in the overlay would be a pure pass-through. Only the dedicated operator
agent sets the env (pointing at its `policy.operator.yaml`) to turn on the
spend gate.

### MCP tool-name namespacing

Hermes may present an MCP tool to the `pre_tool_call` hook either **bare**
(`pipeline_operator_render`) or **namespaced** with the server name
(`mcp__pipeline-operator__pipeline_operator_render`). The overlay matches both:
a policy entry matches if the live tool name **equals** it OR **ends with**
`__<entry>` (the trailing `__`-delimited MCP segment). The `__` boundary keeps
the match precise — an entry `render` does **not** match
`pipeline_operator_render`, only a whole namespaced segment does. List tools by
their **short name** in the policy files; both forms are gated. (The exact live
name is confirmed on the VPS; because matching covers both, the policy file
does not need adjusting if Hermes turns out to namespace.)

## Operator policy profile (`policy.operator.yaml`)

The dedicated **operator** agent (`hermes-agent-operator`, running the
`pipeline-operator` skill) needs a different profile than Ekko: its paid
`render` tool must be spend-gated, while its read/brief tools run free.
`policy.operator.yaml` is that profile, shipped alongside this plugin and
dropped in as the operator container's `policy.yaml` at deploy time. It does
**not** modify Ekko's `policy.yaml` or the in-code defaults.

It maps one-for-one to the `pipeline-operator` MCP tools
(`ekko-skills/pipeline-operator/mcp_server.py`, which delegates to
`helper.py`) — the plugin gates **by tool name**, so the keys are the exact
tool short-names (namespaced forms are matched too; see above):

| Policy key                | Tool                       | Effect                                                                |
| ------------------------- | -------------------------- | --------------------------------------------------------------------- |
| `extra_requires_approval` | `pipeline_operator_render` | **spend gate** — manager approves every render batch in the dashboard |
| `allowlist`               | `pipeline_operator_read`   | read pipeline state without a prompt                                  |
| `allowlist`               | `pipeline_operator_brief`  | author the brief (free write; reviewed via the dashboard stage gate)  |

Because gating uses the tool name, the spend gate is wired to the helper's
`pipeline_operator_render` function: every call to it round-trips the manager
for spend approval. The operator sends all concept previews in a single
`render` call, so the manager approves the whole ideation batch once rather
than per concept. **Do not rename `pipeline_operator_render`** without updating
this file in lock-step.

Deploy it as the operator's policy (do not overwrite Ekko's):

```bash
rsync -a ekko-plugins/voxhorizon_approvals/ \
  vps:/opt/data/home-operator/.hermes/plugins/voxhorizon_approvals/
# drop the operator profile in as that container's policy.yaml:
ssh vps 'cp /opt/data/home-operator/.hermes/plugins/voxhorizon_approvals/policy.operator.yaml \
            /opt/data/home-operator/.hermes/plugins/voxhorizon_approvals/policy.yaml'
```

## Audit log

Each decision becomes one JSONL row in
`/opt/data/logs/voxhorizon-approvals.jsonl`:

```json
{
  "timestamp": "2026-05-18T03:14:15.926Z",
  "tool": "kie_generate",
  "decision": "approved",
  "reason": "operator approve",
  "args_digest": "sha256:a1b2c3...",
  "latency_ms": 1247.31
}
```

Arguments themselves are **never** logged (they may contain secrets). A
16-char prefix of the args hash provides traceability without leaking
content — the worker's `approvals` Supabase table is the canonical
source for full payloads.

Override the path for tests via `VOXHORIZON_APPROVAL_AUDIT_LOG`.

## Local development

```bash
# Install dev deps and run tests.
cd ekko-plugins/voxhorizon-approvals
uv pip install httpx pytest pytest-asyncio pytest-cov
pytest tests/ -v --cov=. --cov-report=term-missing
```

Hot-path latency benchmark:

```bash
python -c "
import time
from policy import evaluate
t = time.perf_counter()
for _ in range(10000):
    evaluate('read_file', {})
print((time.perf_counter() - t) / 10000 * 1e6, 'us/call')
"
# Expect: <50 us/call
```

## Architecture notes

- `policy.py` is pure (no I/O, no time, no async). Hot path is two set
  membership checks per call.
- `client.py` uses `httpx.AsyncClient` with timeouts set just above the
  worker's hard timeout so the worker's structured `rejected` response
  always beats our transport timeout.
- `audit.py` writes JSONL with a module-level lock so multi-threaded
  Hermes doesn't interleave half-lines. Failures are silently swallowed
  — the worker's Supabase log is the canonical record.
- `__init__.py` wraps every code path in `try / except` so ANY error
  triggers fail-closed `{"action": "block", ...}`. The audit log notes
  `"plugin error: ..."` so misconfigurations are traceable.

## Related issues

- HI-13 — this plugin.
- HI-14 — worker-side `/work/hermes/approval` long-poll endpoint.
