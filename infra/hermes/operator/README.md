# Operator profile (hermes-agent-operator)

Repo-managed profile files for the **operator** Hermes agent: the dashboard-only
container `hermes-agent-operator` (VPS data dir `/docker/hermes-operator/data`)
that the worker drives via `docker exec hermes chat`. This is separate from the
Ekko overlay (`infra/hermes/config.yaml.patch`), which targets the different
`hermes-agent-ekko` container.

## Contents

- `SOUL.md` is the operator's always-loaded persona / system prompt. It mirrors
  the gated, per-creative pipeline that `ekko-skills/pipeline-operator/SKILL.md`
  drives (configuration through monitor), and replaces the earlier 3-stage
  ("the pipeline finishes itself") version that predated the QA / compliance /
  copy / spec / launch / monitor stages.

## Deploy / sync (`sync-operator.sh`)

`sync-operator.sh` in this directory is the repo to operator deploy mechanism
(`OPERATOR-BUILDOUT.md` `OP-7`). The deploy-stack workflow only rolls
web/worker/caddy, so this script is how repo-managed operator config reaches
`/docker/hermes-operator/data` on the VPS. Run it there as a sudo-capable user
(e.g. `agents`):

```bash
# on the VPS, from the repo clone
bash /opt/voxhorizon/repo/infra/hermes/operator/sync-operator.sh                    # DRY-RUN
bash /opt/voxhorizon/repo/infra/hermes/operator/sync-operator.sh --apply --restart  # write + restart
```

What it syncs (repo is the source of truth): this `SOUL.md` and the operator
skills (`ekko-skills/{image-ad-authoring, pipeline-operator, creative-qa,
ad-compliance, copy-authoring, campaign-launch, campaign-monitor}`). The approval
plugin/policy is opt-in via `--with-plugin` (it governs the launch HARD gate, so
it is off by default).

Safe by design: DRY-RUN unless `--apply`; backs up the touched surface to
`/docker/backups/` first; per-skill `rsync --delete` scoped INSIDE each skill
dir, so the generic Hermes library skills that ship with the image are never
removed; never touches `.env`, `auth.json`, `config.yaml`, `sessions/`,
`state.db`, `memories/`, `cron/`, or `hooks/`. `SOUL.md` and skills are frozen at
gateway start, so `--restart` (or `docker restart hermes-agent-operator`) loads
them.

Placement note: this directory is provisional pending final `OP-7` sign-off; if
the canonical location changes, move these files and update the script's
`OPERATOR_SKILLS` and paths.
