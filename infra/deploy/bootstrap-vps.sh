#!/usr/bin/env bash
#
# bootstrap-vps.sh — first-time VPS bootstrap for the VoxHorizon stack.
#
# Run AS ROOT (or via sudo) on a fresh Ubuntu 24.04 LTS box. Idempotent:
# re-running on a partially-provisioned box only does the steps that haven't
# been done yet.
#
# What it does (in order):
#   1. Sanity check — confirm we're on Ubuntu 24.04.
#   2. Install base apt packages (ca-certificates, curl, gnupg, ufw).
#   3. Install Docker CE + Compose plugin from Docker's official apt repo.
#   4. Configure UFW: deny incoming by default, allow 22/80/443, enable.
#   5. Run setup-deploy-user.sh (sibling script) to provision the deploy user.
#   6. Clone the repo into /opt/voxhorizon/repo as the deploy user.
#   7. Scaffold /opt/voxhorizon/.env from web + worker .env.example files.
#   8. Symlink /opt/voxhorizon/docker-compose.yml → repo/docker-compose.yml so
#      `docker compose` can be run from /opt/voxhorizon directly.
#   9. Print instructions for GHCR login (this script does NOT bake a token).
#  10. `docker compose pull` (skipped in --dry-run).
#  11. `docker compose up -d` (skipped in --dry-run).
#  12. Hermes-aware sanity: confirm hermes-agent-ekko exists; verify the
#      worker container can reach it via /var/run/docker.sock.
#  13. Print final summary + remaining manual steps (incl. the Hermes-side
#      overlay — see infra/deploy/README.md "Hermes-side overlay").
#
# Flags:
#   --dry-run         Print steps + skip docker pull/up (good for review).
#   --skip-firewall   Skip UFW config (useful in CI / containers without ufw).
#   --repo-url <url>  Override the repo clone URL.
#
# What this script does NOT do:
#   - Bake a GHCR token (you log in manually as deploy after the script).
#   - Fill /opt/voxhorizon/.env values (operator does this).
#   - Touch Cloudflare DNS / SSL settings (operator does this in CF UI).
#   - Modify ../../docker-compose.yml or any other file in the repo.

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
DEPLOY_USER="${DEPLOY_USER:-deploy}"
VOXHORIZON_ROOT="${VOXHORIZON_ROOT:-/opt/voxhorizon}"
REPO_DIR="${VOXHORIZON_ROOT}/repo"
ENV_FILE="${VOXHORIZON_ROOT}/.env"
COMPOSE_LINK="${VOXHORIZON_ROOT}/docker-compose.yml"
REPO_URL="https://github.com/pveloso01/Diogo-Silva-VoxHorizon-Marketing-Control-Panel.git"

DRY_RUN=0
SKIP_FIREWALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --skip-firewall)
      SKIP_FIREWALL=1
      shift
      ;;
    --repo-url)
      REPO_URL="${2:-}"
      if [[ -z "${REPO_URL}" ]]; then
        echo "error: --repo-url requires a value" >&2
        exit 2
      fi
      shift 2
      ;;
    -h|--help)
      sed -n '1,40p' "$0"
      exit 0
      ;;
    *)
      echo "error: unknown flag: $1" >&2
      echo "       see --help for usage" >&2
      exit 2
      ;;
  esac
done

if [[ "${DRY_RUN}" -eq 1 ]]; then
  set -x
fi

# Resolve where this script lives so we can find setup-deploy-user.sh next to it.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
banner() {
  local msg="$1"
  echo
  echo "============================================================"
  echo "  ${msg}"
  echo "============================================================"
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "error: must be run as root (got EUID=${EUID})" >&2
    echo "       try: sudo $0" >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# 1. Sanity: Ubuntu 24.04
# ---------------------------------------------------------------------------
step_sanity() {
  banner "1/13  Sanity: confirming Ubuntu 24.04 LTS"

  if ! command -v lsb_release >/dev/null 2>&1; then
    # lsb-release is part of ubuntu-minimal but bail-with-installer is friendlier
    # than failing.
    apt-get update -qq
    apt-get install -y --no-install-recommends lsb-release >/dev/null
  fi

  local distro version
  distro="$(lsb_release -is)"
  version="$(lsb_release -rs)"

  if [[ "${distro}" != "Ubuntu" ]]; then
    echo "error: expected Ubuntu, got '${distro}'" >&2
    echo "       this bootstrap only supports Ubuntu 24.04 LTS" >&2
    exit 1
  fi

  if [[ "${version}" != "24.04" ]]; then
    echo "error: expected Ubuntu 24.04, got '${version}'" >&2
    echo "       this bootstrap only supports Ubuntu 24.04 LTS" >&2
    exit 1
  fi

  echo "ok: ${distro} ${version}"
}

# ---------------------------------------------------------------------------
# 2. Base apt packages
# ---------------------------------------------------------------------------
step_packages() {
  banner "2/13  Installing base apt packages"

  local need=()
  local pkg
  for pkg in ca-certificates curl gnupg ufw; do
    if ! dpkg -s "${pkg}" >/dev/null 2>&1; then
      need+=("${pkg}")
    fi
  done

  if [[ ${#need[@]} -eq 0 ]]; then
    echo "ok: all base packages already installed"
    return
  fi

  echo "installing: ${need[*]}"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${need[@]}"
}

# ---------------------------------------------------------------------------
# 3. Docker CE + Compose plugin (official apt repo)
# ---------------------------------------------------------------------------
step_docker() {
  banner "3/13  Installing Docker (official apt repo)"

  if command -v docker >/dev/null 2>&1 && docker --version >/dev/null 2>&1; then
    if docker compose version >/dev/null 2>&1; then
      echo "ok: docker + compose plugin already installed ($(docker --version))"
      systemctl enable --now docker >/dev/null 2>&1 || true
      return
    fi
  fi

  install -m 0755 -d /etc/apt/keyrings
  if [[ ! -s /etc/apt/keyrings/docker.gpg ]]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
      | gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
  fi

  local codename
  codename="$(. /etc/os-release && echo "${VERSION_CODENAME}")"
  cat >/etc/apt/sources.list.d/docker.list <<EOF
deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${codename} stable
EOF

  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    docker-ce \
    docker-ce-cli \
    containerd.io \
    docker-buildx-plugin \
    docker-compose-plugin

  systemctl enable --now docker

  docker --version
  docker compose version
}

# ---------------------------------------------------------------------------
# 4. UFW firewall
# ---------------------------------------------------------------------------
step_firewall() {
  banner "4/13  Configuring UFW firewall"

  if [[ "${SKIP_FIREWALL}" -eq 1 ]]; then
    echo "skip: --skip-firewall set"
    return
  fi

  if ! command -v ufw >/dev/null 2>&1; then
    echo "error: ufw not installed (step 2 should have handled this)" >&2
    exit 1
  fi

  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null

  # `ufw allow` is idempotent — re-adding an existing rule is a no-op.
  ufw allow 22/tcp comment 'SSH' >/dev/null
  ufw allow 80/tcp comment 'HTTP (Caddy)' >/dev/null
  ufw allow 443/tcp comment 'HTTPS (Caddy)' >/dev/null
  ufw allow 443/udp comment 'HTTP/3 (Caddy)' >/dev/null

  # --force makes `enable` non-interactive.
  ufw --force enable >/dev/null
  ufw status verbose
}

# ---------------------------------------------------------------------------
# 5. Deploy user (delegates to setup-deploy-user.sh)
# ---------------------------------------------------------------------------
step_deploy_user() {
  banner "5/13  Provisioning deploy user"

  local helper="${SCRIPT_DIR}/setup-deploy-user.sh"
  if [[ ! -x "${helper}" ]]; then
    if [[ -f "${helper}" ]]; then
      chmod +x "${helper}"
    else
      echo "error: helper script not found: ${helper}" >&2
      echo "       this script must live next to setup-deploy-user.sh" >&2
      exit 1
    fi
  fi

  # setup-deploy-user.sh is itself idempotent (creates the user/dirs only if
  # missing). Just invoke it.
  DEPLOY_USER="${DEPLOY_USER}" VOXHORIZON_ROOT="${VOXHORIZON_ROOT}" \
    bash "${helper}"
}

# ---------------------------------------------------------------------------
# 6. Repo clone
# ---------------------------------------------------------------------------
step_repo_clone() {
  banner "6/13  Cloning repo into ${REPO_DIR}"

  if [[ -d "${REPO_DIR}/.git" ]]; then
    echo "ok: repo already cloned at ${REPO_DIR}"
    # Make sure ownership hasn't drifted.
    chown -R "${DEPLOY_USER}:${DEPLOY_USER}" "${REPO_DIR}"
    return
  fi

  if ! command -v git >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git
  fi

  # Clone as the deploy user so the working tree is owned correctly from the
  # start. The parent dir (/opt/voxhorizon) is mode 750 owned by deploy:deploy
  # courtesy of setup-deploy-user.sh.
  sudo -u "${DEPLOY_USER}" git clone "${REPO_URL}" "${REPO_DIR}"
  chown -R "${DEPLOY_USER}:${DEPLOY_USER}" "${REPO_DIR}"
  echo "ok: cloned ${REPO_URL} → ${REPO_DIR}"
}

# ---------------------------------------------------------------------------
# 7. .env scaffold
# ---------------------------------------------------------------------------
step_env_scaffold() {
  banner "7/13  Scaffolding ${ENV_FILE}"

  if [[ -f "${ENV_FILE}" ]]; then
    echo "ok: ${ENV_FILE} already exists — leaving in place"
    return
  fi

  local worker_example="${REPO_DIR}/worker/.env.example"
  local web_example="${REPO_DIR}/web/.env.example"

  if [[ ! -f "${worker_example}" ]] || [[ ! -f "${web_example}" ]]; then
    echo "error: missing .env.example files under ${REPO_DIR}" >&2
    echo "       expected: ${worker_example}" >&2
    echo "       expected: ${web_example}" >&2
    exit 1
  fi

  # Write banner + concat both templates into the scaffold. The operator must
  # fill in real values before any deploy can succeed.
  {
    cat <<'BANNER'
# =============================================================================
# /opt/voxhorizon/.env — VPS production environment.
# -----------------------------------------------------------------------------
# This file was scaffolded by infra/deploy/bootstrap-vps.sh by concatenating
# worker/.env.example and web/.env.example from the repo. Every value below
# MUST BE FILLED IN before the stack will run. Anything left as a placeholder
# (looking like CHANGE_ME / your-... / etc.) is unsafe to ship.
#
# After editing, this file must remain:
#   - chmod 600
#   - chown deploy:deploy
#
# See SECRETS.md > VPS production secrets for the canonical list of required
# variables and where each one comes from.
# =============================================================================

# -----------------------------------------------------------------------------
# WORKER (FastAPI) — from worker/.env.example
# -----------------------------------------------------------------------------
BANNER
    cat "${worker_example}"
    cat <<'BANNER'

# -----------------------------------------------------------------------------
# WEB (Next.js) — from web/.env.example
# -----------------------------------------------------------------------------
BANNER
    cat "${web_example}"
  } >"${ENV_FILE}"

  chown "${DEPLOY_USER}:${DEPLOY_USER}" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  echo "ok: scaffolded ${ENV_FILE} (chmod 600, owned by ${DEPLOY_USER}). FILL IN VALUES before deploying."
}

# ---------------------------------------------------------------------------
# 8. Symlink docker-compose.yml into /opt/voxhorizon
# ---------------------------------------------------------------------------
step_compose_symlink() {
  banner "8/13  Linking docker-compose.yml into ${VOXHORIZON_ROOT}"

  local target="${REPO_DIR}/docker-compose.yml"

  if [[ ! -f "${target}" ]]; then
    echo "error: ${target} not found — repo clone step must have failed" >&2
    exit 1
  fi

  if [[ -L "${COMPOSE_LINK}" ]]; then
    local current
    current="$(readlink -f "${COMPOSE_LINK}")"
    if [[ "${current}" == "$(readlink -f "${target}")" ]]; then
      echo "ok: ${COMPOSE_LINK} already points at ${target}"
      return
    fi
    rm "${COMPOSE_LINK}"
  elif [[ -e "${COMPOSE_LINK}" ]]; then
    echo "error: ${COMPOSE_LINK} exists but is not a symlink — refusing to overwrite" >&2
    echo "       remove it manually if you want the script to (re)create the link" >&2
    exit 1
  fi

  ln -s "${target}" "${COMPOSE_LINK}"
  # Symlink ownership is metadata-only; chown for tidiness so `ls -l` is clean.
  chown -h "${DEPLOY_USER}:${DEPLOY_USER}" "${COMPOSE_LINK}"
  echo "ok: ${COMPOSE_LINK} → ${target}"
  echo "    run docker compose from ${VOXHORIZON_ROOT} — env_file: /opt/voxhorizon/.env resolves cleanly there."
}

# ---------------------------------------------------------------------------
# 9. GHCR login — manual step (this script never bakes a token)
# ---------------------------------------------------------------------------
step_ghcr_login() {
  banner "9/13  GHCR login (manual)"

  cat <<EOF
This script does NOT log into GHCR for you — that would mean baking a Personal
Access Token into the bootstrap. Do it interactively after this script finishes:

    sudo -u ${DEPLOY_USER} -i
    docker login ghcr.io -u <your-github-username>
    # paste a classic PAT with read:packages when prompted (or use 'echo <token> | docker login --password-stdin')

The deploy user's docker config is then cached at /home/${DEPLOY_USER}/.docker/config.json
so subsequent `docker compose pull` calls Just Work.

See SECRETS.md > GitHub Actions deploy secrets for token guidance.
EOF
}

# ---------------------------------------------------------------------------
# 10. First pull
# ---------------------------------------------------------------------------
step_first_pull() {
  banner "10/13  docker compose pull"

  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "skip: --dry-run"
    return
  fi

  if [[ ! -s "${ENV_FILE}" ]]; then
    echo "skip: ${ENV_FILE} is empty — fill in values before running pull"
    return
  fi

  # Run as deploy so the docker login cache for that user is used.
  if ! sudo -u "${DEPLOY_USER}" -H sh -c "cd '${VOXHORIZON_ROOT}' && docker compose pull"; then
    echo "warn: docker compose pull failed — likely no GHCR login yet, or .env still has placeholders." >&2
    echo "      Re-run this script after manual GHCR login, or run it yourself as deploy." >&2
    return
  fi
  echo "ok: pulled images"
}

# ---------------------------------------------------------------------------
# 11. First up
# ---------------------------------------------------------------------------
step_first_up() {
  banner "11/13  docker compose up -d"

  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "skip: --dry-run"
    return
  fi

  if [[ ! -s "${ENV_FILE}" ]]; then
    echo "skip: ${ENV_FILE} is empty — fill in values before running up"
    return
  fi

  if ! sudo -u "${DEPLOY_USER}" -H sh -c "cd '${VOXHORIZON_ROOT}' && docker compose up -d --remove-orphans"; then
    echo "warn: docker compose up -d failed — see the output above." >&2
    echo "      Common causes: missing .env values, missing GHCR login, Cloudflare DNS not pointing at this VPS." >&2
    return
  fi
  echo "ok: stack is up"
}

# ---------------------------------------------------------------------------
# 12. Hermes-aware sanity check (idempotent)
# ---------------------------------------------------------------------------
#
# Post-Hermes integration the worker bridges to the operator-managed
# `hermes-agent-ekko` container via the shared Docker socket. None of this is
# installed by us — Hostinger's HVPS Hermes Agent product provisions Ekko
# under /docker/hermes-agent-t4k4/ — but we can verify the bridge is wired
# correctly before the operator starts in on the manual overlay.
#
# Three checks, each idempotent + non-fatal:
#   a. Is `hermes-agent-ekko` running? (If not: print guidance and bail soft.)
#   b. Can the worker container resolve and reach it via docker.sock?
#   c. Print the next-step list (Hermes-side overlay) so the operator can't
#      miss it.
step_hermes_sanity() {
  banner "12/13  Hermes-aware sanity check"

  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "skip: --dry-run"
    return
  fi

  if [[ ! -s "${ENV_FILE}" ]]; then
    echo "skip: ${ENV_FILE} is empty — Hermes sanity needs a running stack"
    return
  fi

  # 12a. Confirm hermes-agent-ekko exists on the daemon.
  if ! docker ps --filter "name=hermes-agent-ekko" --format '{{.Names}}' \
      | grep -qx 'hermes-agent-ekko'; then
    cat <<'EOF' >&2

  warn: hermes-agent-ekko is NOT running on this host.
        Our worker bridges into Ekko via /var/run/docker.sock. Without the
        Hermes container, /work/hermes/* endpoints will fail.

        Action (operator):
          1. Confirm the Hostinger HVPS Hermes Agent product is provisioned on
             this VPS. The container should live under /docker/hermes-agent-t4k4/.
          2. Bring it up:
               cd /docker/hermes-agent-t4k4 && docker compose up -d
          3. Re-run this bootstrap (idempotent) once it's running.

EOF
    return
  fi
  echo "ok: hermes-agent-ekko is running"

  # 12b. Confirm the worker container can reach the Hermes container via
  # the shared Docker socket. We only run this if the worker came up in step 11.
  if sudo -u "${DEPLOY_USER}" -H sh -c "cd '${VOXHORIZON_ROOT}' && docker compose ps --filter status=running --services" \
      | grep -qx 'worker'; then
    local probe
    probe="$(sudo -u "${DEPLOY_USER}" -H sh -c "cd '${VOXHORIZON_ROOT}' && \
      docker compose exec -T worker python -c \"\
import docker, sys
try:
    c = docker.from_env().containers.get('hermes-agent-ekko')
    print(c.status)
except Exception as e:
    print('error: ' + str(e), file=sys.stderr); sys.exit(1)\" 2>&1" || true)"

    if [[ "${probe}" == "running" ]]; then
      echo "ok: worker can reach hermes-agent-ekko via /var/run/docker.sock (status=running)"
    else
      cat >&2 <<EOF

  warn: worker container could not reach hermes-agent-ekko via the Docker socket.
        Probe output:
          ${probe}

        Common causes:
          - The worker doesn't have /var/run/docker.sock mounted (check docker-compose.yml)
          - The worker user is not in the host 'docker' group (check group_add: in compose)
          - hermes-agent-ekko stopped between checks 12a and 12b

        Action: docker compose logs --tail=50 worker, and confirm the
        volumes:/group_add: lines in docker-compose.yml are present.

EOF
    fi
  else
    echo "note: worker container is not running — skipping 12b probe."
    echo "      run 'docker compose up -d worker' once .env is filled in."
  fi
}

# ---------------------------------------------------------------------------
# 13. Final summary
# ---------------------------------------------------------------------------
step_summary() {
  banner "13/13  Done — next steps"

  cat <<EOF

  Bootstrap finished. What's still required (manual):

    1. Fill in real values in ${ENV_FILE}:
         sudo -u ${DEPLOY_USER} -e nano ${ENV_FILE}
       (See SECRETS.md > VPS production secrets AND
        SECRETS.md > Hermes integration secrets for every required variable.)

    2. Set VOXHORIZON_DASHBOARD_HOST in ${ENV_FILE} to the public hostname
       (e.g. dashboard.voxhorizon.com). Caddy uses it for TLS issuance.

    3. Cloudflare DNS:
         - A record dashboard.voxhorizon.com → this VPS's public IP
         - Proxy: ON (orange cloud)
         - SSL/TLS mode: Full (Strict)
       See SECRETS.md > Cloudflare DNS setup (operator).

    4. Log the deploy user into GHCR (one-time):
         sudo -u ${DEPLOY_USER} -i
         docker login ghcr.io -u <your-github-username>

    5. Append the GitHub Actions deploy public key to:
         /home/${DEPLOY_USER}/.ssh/authorized_keys
       (Format documented in SECRETS.md > GitHub Actions deploy secrets.)

    6. Set GitHub repo secrets so the deploy workflow can SSH back in:
         VPS_HOST, VPS_USER, VPS_SSH_KEY
       (See SECRETS.md > GitHub Actions deploy secrets.)

    7. APPLY THE HERMES-SIDE OVERLAY (one-shot, after the stack is up):
         See infra/deploy/README.md > "Hermes-side overlay" for the full
         steps. tl;dr — copy three skills + one plugin from the repo into
         the operator-managed hermes-agent-ekko container, paste the matching
         bearer tokens into /opt/data/.env on the Hermes side, and restart
         the Ekko container. None of this can run from this bootstrap
         because Ekko is operator-managed.

           - Patch /docker/hermes-agent-t4k4/config.yaml using
             infra/hermes/config.yaml.patch
           - Copy ekko-skills/{dashboard-publish,dashboard-chat-publish,dashboard-task-result}
             into /opt/data/skills/
           - Copy ekko-plugins/voxhorizon_approvals/ into
             /opt/data/home/.hermes/plugins/
           - Set SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY /
             DASHBOARD_WEBHOOK_URL / DASHBOARD_WEBHOOK_TOKEN /
             VOXHORIZON_APPROVAL_WORKER_URL / VOXHORIZON_APPROVAL_TOKEN
             in /opt/data/.env (Hermes side)
           - Restart hermes-agent-ekko

    8. From a workstation, trigger the first deploy:
         gh workflow run deploy-stack.yml --ref main
       Or:  Actions → deploy-stack → Run workflow

  Full deploy contract: infra/deploy/README.md

EOF
}

# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------
main() {
  require_root

  step_sanity
  step_packages
  step_docker
  step_firewall
  step_deploy_user
  step_repo_clone
  step_env_scaffold
  step_compose_symlink
  step_ghcr_login
  step_first_pull
  step_first_up
  step_hermes_sanity
  step_summary
}

main "$@"
