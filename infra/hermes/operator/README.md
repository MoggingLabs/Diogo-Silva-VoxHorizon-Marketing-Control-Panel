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

## Deploy / sync (manual today)

> The repo to operator sync is still **manual** (`OPERATOR-BUILDOUT.md` item
> `OP-7`). No CI path rolls `/docker/hermes-operator/data` yet, so this file is
> tracked here as the source of truth and copied to the VPS by hand.

`SOUL.md` is frozen at gateway start, so a restart is required to apply a change:

```bash
sudo cp infra/hermes/operator/SOUL.md /docker/hermes-operator/data/SOUL.md
docker restart hermes-agent-operator
docker exec hermes-agent-operator sh -c 'sed -n 1,3p /opt/data/SOUL.md'   # verify
```

Placement note: this directory is provisional pending the `OP-7` decision on the
canonical repo to operator deploy/sync mechanism. If that lands elsewhere, move
these files to match.
