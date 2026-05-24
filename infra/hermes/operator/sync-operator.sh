#!/usr/bin/env bash
# sync-operator.sh - push repo-managed operator config to the live operator.
#
# The repo is the source of truth for hermes-agent-operator's SKILLS and SOUL
# (and, opt-in, the voxhorizon-approvals plugin/policy). The deploy-stack
# workflow only rolls web/worker/caddy, NOT the operator container, so this
# script is the repo -> /docker/hermes-operator/data sync mechanism
# (OPERATOR-BUILDOUT.md, OP-7).
#
# Safe by design:
#   * DRY-RUN by default; pass --apply to write anything.
#   * Syncs ONLY the repo-owned surface: the 7 operator skills + SOUL.md
#     (+ the approval plugin only with --with-plugin). It never touches .env,
#     auth.json, config.yaml, sessions/, state.db, memories/, cron/, or hooks/.
#   * Per-skill "rsync --delete" scoped INSIDE each skill dir, so the generic
#     Hermes library skills that ship with the image are never removed.
#   * Backs up the touched surface to /docker/backups/ before --apply.
#   * Run it on the VPS as a sudo-capable user (e.g. agents) or as root.
#
# Usage:
#   bash sync-operator.sh                      # dry-run (show what would change)
#   bash sync-operator.sh --apply              # write changes (no restart)
#   bash sync-operator.sh --apply --restart    # write + restart the operator
#   bash sync-operator.sh --with-plugin --apply --restart
#   bash sync-operator.sh --repo /path --ref origin/main --apply
set -euo pipefail

REPO="/opt/voxhorizon/repo"
DATA="/docker/hermes-operator/data"
CONTAINER="hermes-agent-operator"
OWNER="10000:10000"          # operator data dir is owned by uid/gid 10000 (hermes)
REF="origin/main"
APPLY=0
RESTART=0
PULL=1
WITH_PLUGIN=0

# The operator agent's OWN skills live in the self-contained operator home
# (infra/hermes/operator/skills) so the agent does not depend on the legacy
# ekko-skills namespace. The remaining gate/rubric skills are still sourced from
# ekko-skills (shared provenance with the worker's seeded compliance/QA rules).
OPERATOR_OWNED_DIR="$REPO/infra/hermes/operator/skills"
SHARED_SKILLS_DIR="$REPO/ekko-skills"
OPERATOR_OWNED_SKILLS=(
  image-ad-authoring
  pipeline-operator
  video-ad-authoring
)
SHARED_SKILLS=(
  ad-compliance
  campaign-launch
  campaign-monitor
  copy-authoring
  creative-qa
)
OPERATOR_SKILLS=("${OPERATOR_OWNED_SKILLS[@]}" "${SHARED_SKILLS[@]}")

# Resolve the repo source dir for a skill (operator-owned home vs shared ekko).
skill_src() {
  for o in "${OPERATOR_OWNED_SKILLS[@]}"; do
    [ "$o" = "$1" ] && { echo "$OPERATOR_OWNED_DIR/$1"; return; }
  done
  echo "$SHARED_SKILLS_DIR/$1"
}
EXCLUDES=(--exclude 'tests/' --exclude '__pycache__/' --exclude '*.pyc' --exclude '.venv/' --exclude '*.log')

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --restart) RESTART=1 ;;
    --no-pull) PULL=0 ;;
    --with-plugin) WITH_PLUGIN=1 ;;
    --repo) REPO="$2"; shift ;;
    --ref) REF="$2"; shift ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
log() { printf '\n== %s ==\n' "$*"; }

# Run git as the repo owner (the deploy clone is owned by 'deploy'); avoids
# git's dubious-ownership refusal and reuses the owner's fetch credentials.
REPO_OWNER="$($SUDO stat -c %U "$REPO" 2>/dev/null || echo root)"
gitc() {
  if [ "$REPO_OWNER" = "root" ] || [ "$(id -un)" = "$REPO_OWNER" ]; then
    $SUDO git -C "$REPO" "$@"
  else
    $SUDO -u "$REPO_OWNER" git -C "$REPO" "$@"
  fi
}

# --- preconditions ---
[ -d "$REPO" ] || { echo "repo not found: $REPO (pass --repo)" >&2; exit 1; }
$SUDO test -d "$DATA" || { echo "operator data dir not found: $DATA" >&2; exit 1; }
docker inspect "$CONTAINER" >/dev/null 2>&1 || { echo "container not found: $CONTAINER" >&2; exit 1; }
command -v rsync >/dev/null || { echo "rsync not installed on the VPS" >&2; exit 1; }

# --- refresh the repo clone to the target ref ---
if [ "$PULL" -eq 1 ]; then
  log "fetch + reset $REPO to $REF"
  if gitc fetch --quiet origin; then
    gitc reset --hard "$REF" || echo "WARN: git reset failed; using current checkout"
  else
    echo "WARN: git fetch failed; syncing whatever is checked out"
  fi
fi
echo "repo at $(gitc rev-parse --short HEAD 2>/dev/null || echo '?')"

SOUL_SRC="$REPO/infra/hermes/operator/SOUL.md"
PLUGIN_SRC="$REPO/infra/hermes/operator/plugins/voxhorizon_approvals"
DRY="--dry-run"; [ "$APPLY" -eq 1 ] && DRY=""

# --- backup the touched surface before writing ---
if [ "$APPLY" -eq 1 ]; then
  TS="$(date -u +%Y%m%dT%H%M%SZ)"
  BK="/docker/backups/hermes-operator-presync-$TS.tar.gz"
  PATHS=("SOUL.md" "plugins/voxhorizon_approvals")
  for s in "${OPERATOR_SKILLS[@]}"; do PATHS+=("skills/$s"); done
  log "backup touched surface -> $BK"
  $SUDO tar czf "$BK" -C "$DATA" "${PATHS[@]}" 2>/dev/null || echo "WARN: backup partial/failed"
fi

# --- sync each operator skill (scoped --delete; generic skills untouched) ---
# Operator-owned skills come from the self-contained operator home; the shared
# gate/rubric skills still come from ekko-skills (see skill_src).
for s in "${OPERATOR_SKILLS[@]}"; do
  SRC="$(skill_src "$s")"
  if [ ! -d "$SRC" ]; then echo "WARN: repo skill missing, skipping: $s ($SRC)"; continue; fi
  log "skill $s ${DRY:+(dry-run)} [from ${SRC#"$REPO"/}]"
  $SUDO rsync -a --delete $DRY --itemize-changes "${EXCLUDES[@]}" "$SRC/" "$DATA/skills/$s/"
done

# --- SOUL.md ---
if [ -f "$SOUL_SRC" ]; then
  log "SOUL.md ${DRY:+(dry-run)}"
  if [ "$APPLY" -eq 1 ]; then $SUDO cp "$SOUL_SRC" "$DATA/SOUL.md"; else $SUDO diff -u "$DATA/SOUL.md" "$SOUL_SRC" || true; fi
else
  echo "WARN: $SOUL_SRC missing (merge the PR that adds it, then re-run); SOUL skipped"
fi

# --- approval plugin (opt-in: it manages the launch HARD-gate policy) ---
if [ "$WITH_PLUGIN" -eq 1 ] && [ -d "$PLUGIN_SRC" ]; then
  log "plugin voxhorizon_approvals ${DRY:+(dry-run)}"
  $SUDO rsync -a --delete $DRY --itemize-changes "${EXCLUDES[@]}" "$PLUGIN_SRC/" "$DATA/plugins/voxhorizon_approvals/"
  if [ "$APPLY" -eq 1 ] && [ -f "$DATA/plugins/voxhorizon_approvals/policy.operator.yaml" ]; then
    log "activate policy.operator.yaml -> policy.yaml"
    $SUDO cp "$DATA/plugins/voxhorizon_approvals/policy.operator.yaml" "$DATA/plugins/voxhorizon_approvals/policy.yaml"
  fi
fi

if [ "$APPLY" -eq 0 ]; then
  echo; echo "DRY-RUN complete. Re-run with --apply (optionally --restart) to write."
  exit 0
fi

# --- match ownership to the data dir, then restart to load (frozen at start) ---
log "chown synced paths -> $OWNER"
[ -f "$DATA/SOUL.md" ] && $SUDO chown "$OWNER" "$DATA/SOUL.md" || true
for s in "${OPERATOR_SKILLS[@]}"; do [ -d "$DATA/skills/$s" ] && $SUDO chown -R "$OWNER" "$DATA/skills/$s" || true; done
[ "$WITH_PLUGIN" -eq 1 ] && $SUDO chown -R "$OWNER" "$DATA/plugins/voxhorizon_approvals" || true

if [ "$RESTART" -eq 1 ]; then
  log "restart $CONTAINER"
  docker restart "$CONTAINER" >/dev/null
  sleep 3
  log "verify"
  docker exec "$CONTAINER" sh -c 'sed -n 1,2p /opt/data/SOUL.md' || true
  docker exec "$CONTAINER" hermes skills list 2>/dev/null | grep -E 'pipeline-operator|ad-compliance|campaign-monitor' || echo "(verify skills manually)"
else
  echo; echo "Applied. SOUL.md + skills are frozen at gateway start - run with --restart (or 'docker restart $CONTAINER') to load them."
fi
log "done"
