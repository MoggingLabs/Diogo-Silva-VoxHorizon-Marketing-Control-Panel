# Operator-owned skills (self-contained)

These are the `hermes-agent-operator` agent's OWN skills. The operator agent is
self-contained: it loads these from its own home rather than depending on the
legacy `ekko-skills/` namespace shared with the rest of the panel.

| Skill | Role |
|---|---|
| `pipeline-operator` | The operator playbook + MCP server/helper that drive a pipeline across the 12 stages and call the worker tools. |
| `image-ad-authoring` | Pure authoring scaffolding for image-ad briefs + concepts. |
| `video-ad-authoring` | Pure authoring scaffolding for video-ad briefs + script concepts. |

`sync-operator.sh` (one dir up) deploys these to the operator container's
`/opt/data/skills/` (operator-owned skills source from HERE; the shared
gate/rubric skills - `ad-compliance`, `creative-qa`, `copy-authoring`,
`campaign-launch`, `campaign-monitor` - still source from `ekko-skills/` because
the worker cites their reference rubrics as the provenance of its seeded
compliance/QA rules).

Each skill keeps the repo's dual-surface shape: `SKILL.md` (judgment) +
`helper.py` (pure, unit-tested scaffolding) + `tests/` (+ `mcp_server.py` for
`pipeline-operator`). Tests are stdlib/`httpx`-only; run them per skill, e.g.
`cd pipeline-operator && uvx --with pytest --with httpx --with pytest-asyncio pytest tests/`.

These were migrated (copied) from `ekko-skills/` so the operator stops depending
on that namespace; the `ekko-skills/` copies are left intact for safety and are
now superseded for the operator agent by these.
