# ekko-plugins

Hermes/Ekko plugins maintained alongside the VoxHorizon dashboard.

Each subdirectory is a self-contained Hermes plugin: it has a
`plugin.yaml` manifest, an `__init__.py` with a `register(ctx)` entry
point, and supporting modules + tests. Plugins are committed here so
they go through code review and CI; they are **deployed** by copying the
directory to `/opt/data/home/.hermes/plugins/<plugin-name>/` on the VPS
and enabling it in `/opt/data/config.yaml`. The deployment step is
operator-driven, not part of CI.

## Layout

```
ekko-plugins/
└── voxhorizon-approvals/   # HI-13 — dashboard-driven tool-call approvals
    ├── plugin.yaml
    ├── __init__.py
    ├── policy.py
    ├── policy.yaml
    ├── client.py
    ├── audit.py
    ├── tests/
    └── README.md
```

## Conventions

* **Pure policy modules** keep I/O out of the hot path. Performance
  budgets (e.g. `<1ms` for the approvals gate) are asserted in tests.
* **Fail-closed**. Anything that prevents reaching a definitive
  authorisation outcome becomes `{"action": "block", ...}` rather than
  a silent allow.
* **JSONL audit logs** under `/opt/data/logs/<plugin>.jsonl` (one row
  per decision). Args themselves are NEVER recorded — only their
  digests — so the log can be retained without exposing secrets.
* **Env vars** are listed in each plugin's `plugin.yaml::requires_env`
  so the operator can validate config at install time.

## Adding a plugin

1. Create `ekko-plugins/<name>/` with `plugin.yaml` + `__init__.py`
   exporting `register(ctx)`.
2. Add tests under `<name>/tests/` — coverage gate is per-plugin (see
   each plugin's README).
3. Update the deployment doc in each plugin's `README.md` with the
   exact `rsync` / `docker restart` steps.
4. CI runs the plugin's pytest suite via the worker's uv environment;
   no separate workflow is needed.

## Related repos

* `silva-1337/ekko` — the upstream Ekko/Hermes runtime. This directory
  is intentionally NOT a submodule of that repo; we ship the plugin
  with the dashboard's release artifacts and copy it onto the VPS.
