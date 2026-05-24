# Operator-owned plugins (self-contained)

The `hermes-agent-operator` agent's OWN Hermes plugins. Loaded from here so the
operator does not depend on the legacy `ekko-plugins/` namespace.

| Plugin | Role |
|---|---|
| `voxhorizon_approvals` | The approval gate: maps each tool call to allow / ask-operator / block. `policy.py` is the pure in-code engine; `policy.operator.yaml` is the operator profile (allowlist / extra_requires_approval); `policy_overlay.py` merges them. The operator runs with `policy.operator.yaml` activated as `policy.yaml`. |

`sync-operator.sh` (two dirs up) deploys this to the operator container's
`/opt/data/plugins/voxhorizon_approvals/` with `--with-plugin`, then activates
`policy.operator.yaml` as the live `policy.yaml`.

Run the plugin tests from the plugin dir (its `conftest.py` + `testpaths` set up
the import context):
`cd voxhorizon_approvals && uvx --with pytest --with httpx --with pyyaml --with pytest-asyncio pytest`.

Migrated (copied) from `ekko-plugins/`; that copy is left intact for safety and
is now superseded for the operator agent by this one.
