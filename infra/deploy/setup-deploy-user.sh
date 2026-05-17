#!/usr/bin/env bash
#
# setup-deploy-user.sh — provision the `deploy` user on a fresh VPS so the
# VPS-4 GitHub Actions workflow can SSH in and roll the worker.
#
# Run AS ROOT (or via sudo) on the VPS, once, after Docker is installed.
# Idempotent: re-running on an already-provisioned box is a no-op.
#
# What it does:
#   1. Creates a `deploy` system user (UID < 1000, no shell prompt at login).
#   2. Adds `deploy` to the `docker` group so it can drive `docker compose`.
#   3. Creates /opt/voxhorizon, owned by deploy:deploy, mode 750.
#   4. Sets up ~deploy/.ssh with mode 700 + an empty authorized_keys
#      (chmod 600). The operator pastes the workflow's public key in
#      afterwards — see ../../SECRETS.md#github-actions-deploy-secrets.
#   5. Does NOT install Docker, configure firewalls, write /opt/voxhorizon/.env,
#      or clone the repo. Those steps are documented in infra/deploy/README.md
#      and SECRETS.md.
#
# This script is operator documentation that happens to be executable. Read it
# top-to-bottom before running. Adjust DEPLOY_USER / VOXHORIZON_ROOT if the
# defaults don't match your VPS.

set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-deploy}"
VOXHORIZON_ROOT="${VOXHORIZON_ROOT:-/opt/voxhorizon}"

# ---------------------------------------------------------------------------
# Sanity: we need root for useradd, usermod, chown, and mkdir under /opt.
# ---------------------------------------------------------------------------
if [[ "${EUID}" -ne 0 ]]; then
  echo "error: must be run as root (got EUID=${EUID})" >&2
  echo "       try: sudo $0" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. User. System user, no password, default shell so cron / systemd can use
#    it normally. Home is /home/deploy (so ~deploy/.ssh resolves cleanly).
# ---------------------------------------------------------------------------
if id "${DEPLOY_USER}" >/dev/null 2>&1; then
  echo "user '${DEPLOY_USER}' already exists — skipping creation"
else
  useradd \
    --system \
    --create-home \
    --home-dir "/home/${DEPLOY_USER}" \
    --shell /bin/bash \
    --comment "VoxHorizon deploy user (GHA SSH target)" \
    "${DEPLOY_USER}"
  echo "created user '${DEPLOY_USER}'"
fi

# Lock the password so the only way in is via SSH key (which we'll set up below).
passwd --lock "${DEPLOY_USER}" >/dev/null

# ---------------------------------------------------------------------------
# 2. docker group membership. The GHA workflow runs `docker compose ...` as
#    this user; without group membership every command would need sudo.
# ---------------------------------------------------------------------------
if ! getent group docker >/dev/null; then
  echo "error: 'docker' group does not exist — install Docker before running this script" >&2
  echo "       see https://docs.docker.com/engine/install/ for your distro" >&2
  exit 1
fi

if id -nG "${DEPLOY_USER}" | tr ' ' '\n' | grep -qx docker; then
  echo "user '${DEPLOY_USER}' already in docker group — skipping"
else
  usermod -aG docker "${DEPLOY_USER}"
  echo "added '${DEPLOY_USER}' to docker group"
fi

# ---------------------------------------------------------------------------
# 3. /opt/voxhorizon — repo clone + .env + compose state live here. The
#    workflow does its `git reset --hard origin/main` against this directory.
# ---------------------------------------------------------------------------
mkdir -p "${VOXHORIZON_ROOT}"
chown "${DEPLOY_USER}:${DEPLOY_USER}" "${VOXHORIZON_ROOT}"
chmod 750 "${VOXHORIZON_ROOT}"
echo "ensured ${VOXHORIZON_ROOT} owned by ${DEPLOY_USER}:${DEPLOY_USER} (mode 750)"

# ---------------------------------------------------------------------------
# 4. ~deploy/.ssh scaffold. authorized_keys starts empty; the operator pastes
#    the GitHub Actions deploy public key in afterwards. The recommended line
#    format (with from= and option flags) is documented in SECRETS.md.
# ---------------------------------------------------------------------------
DEPLOY_HOME="$(getent passwd "${DEPLOY_USER}" | cut -d: -f6)"
SSH_DIR="${DEPLOY_HOME}/.ssh"
AUTH_KEYS="${SSH_DIR}/authorized_keys"

install -d -m 700 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" "${SSH_DIR}"

if [[ ! -f "${AUTH_KEYS}" ]]; then
  touch "${AUTH_KEYS}"
  chown "${DEPLOY_USER}:${DEPLOY_USER}" "${AUTH_KEYS}"
  chmod 600 "${AUTH_KEYS}"
  echo "created empty ${AUTH_KEYS} (mode 600)"
else
  echo "${AUTH_KEYS} already exists — leaving in place"
fi

# ---------------------------------------------------------------------------
# Summary + next steps.
# ---------------------------------------------------------------------------
cat <<EOF

  deploy user provisioned.

  Next steps (do these manually):

    1. Append the GitHub Actions deploy public key to:
         ${AUTH_KEYS}
       Recommended line format (see SECRETS.md > GitHub Actions deploy secrets):
         from="<gh-actions-cidr>",no-port-forwarding,no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAA... github-actions-deploy

    2. Clone the repo into ${VOXHORIZON_ROOT} as the deploy user:
         sudo -u ${DEPLOY_USER} git clone https://github.com/pveloso01/Diogo-Silva-VoxHorizon-Marketing-Control-Panel.git ${VOXHORIZON_ROOT}
       (Or move an existing checkout in and fix ownership.)

    3. Drop /opt/voxhorizon/.env (chmod 600, owned by ${DEPLOY_USER}:${DEPLOY_USER}).
       See SECRETS.md > VPS production secrets for the required keys.

    4. Test the SSH path from a workstation:
         ssh -i ~/.ssh/voxhorizon_deploy ${DEPLOY_USER}@<vps-host> 'docker compose version'

    5. From GitHub: Actions > deploy-worker > Run workflow (workflow_dispatch).
       The first successful run validates the whole chain end to end.

EOF
