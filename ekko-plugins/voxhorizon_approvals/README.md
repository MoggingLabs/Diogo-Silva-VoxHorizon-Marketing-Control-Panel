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

| Key                       | Effect                                           |
|---------------------------|--------------------------------------------------|
| `allowlist`               | Adds tools to the in-code ALLOWLIST              |
| `extra_requires_approval` | Adds tools to the in-code REQUIRES_APPROVAL set  |
| `blocklist`               | Tools that are always rejected without operator  |

In-code defaults always win over a softening override — for example,
adding `shell_command` to `allowlist` does **not** disable the
`ALWAYS_ASK_PATTERNS` check for `rm -rf` / `dd` / `mkfs`. That
defense-in-depth is intentional: it means a malicious override of
`policy.yaml` still can't smuggle a destructive command past the gate.

## Audit log

Each decision becomes one JSONL row in
`/opt/data/logs/voxhorizon-approvals.jsonl`:

```json
{"timestamp":"2026-05-18T03:14:15.926Z","tool":"kie_generate",
 "decision":"approved","reason":"operator approve",
 "args_digest":"sha256:a1b2c3...","latency_ms":1247.31}
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

* `policy.py` is pure (no I/O, no time, no async). Hot path is two set
  membership checks per call.
* `client.py` uses `httpx.AsyncClient` with timeouts set just above the
  worker's hard timeout so the worker's structured `rejected` response
  always beats our transport timeout.
* `audit.py` writes JSONL with a module-level lock so multi-threaded
  Hermes doesn't interleave half-lines. Failures are silently swallowed
  — the worker's Supabase log is the canonical record.
* `__init__.py` wraps every code path in `try / except` so ANY error
  triggers fail-closed `{"action": "block", ...}`. The audit log notes
  `"plugin error: ..."` so misconfigurations are traceable.

## Related issues

* HI-13 — this plugin.
* HI-14 — worker-side `/work/hermes/approval` long-poll endpoint.
