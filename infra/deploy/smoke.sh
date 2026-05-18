#!/usr/bin/env bash
#
# infra/deploy/smoke.sh — post-deploy stack smoke test.
#
# Exercises the two health probes that gate "is this VPS healthy?":
#
#   1. Public dashboard /api/health (served by the Next.js web container,
#      fronted by Caddy). Asserts HTTP 200 and `"ok": true` in the JSON
#      body. This is the same surface Uptime Robot polls.
#
#   2. (Optional) Internal worker /work/health. The worker container is
#      not publicly reachable — port 8000 is only on the Docker compose
#      network and the VPS firewall blocks inbound :8000. So this leg is
#      only exercised when --ssh-vps <user@host> is provided; we then
#      SSH in and run the auth'd curl from inside the web container.
#
# Exit code is non-zero on any failed assertion. Intended to be run as
# the last step of a deploy run (manual or CI), or any time an operator
# wants to sanity-check production from their workstation.
#
# Usage:
#   ./infra/deploy/smoke.sh
#   ./infra/deploy/smoke.sh --dashboard dashboard.voxhorizon.com
#   ./infra/deploy/smoke.sh --dashboard dashboard.voxhorizon.com \
#                           --ssh-vps deploy@vps.example.com
#   ./infra/deploy/smoke.sh --protocol http --dashboard localhost:3000

set -euo pipefail

DASHBOARD="dashboard.voxhorizon.example.com"
PROTOCOL="https"
SSH_VPS=""

usage() {
  cat <<'EOF'
Usage: smoke.sh [--dashboard <host>] [--protocol <http|https>] [--ssh-vps <user@host>]

Options:
  --dashboard <host>     Public dashboard host (default: dashboard.voxhorizon.example.com)
  --protocol  <proto>    http or https (default: https)
  --ssh-vps   <user@host> If given, SSH to the VPS and probe the internal worker too
  -h, --help             Show this help and exit
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dashboard)
      [[ $# -ge 2 ]] || { echo "smoke.sh: --dashboard requires a value" >&2; exit 2; }
      DASHBOARD="$2"
      shift 2
      ;;
    --protocol)
      [[ $# -ge 2 ]] || { echo "smoke.sh: --protocol requires a value" >&2; exit 2; }
      PROTOCOL="$2"
      shift 2
      ;;
    --ssh-vps)
      [[ $# -ge 2 ]] || { echo "smoke.sh: --ssh-vps requires a value" >&2; exit 2; }
      SSH_VPS="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "smoke.sh: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$PROTOCOL" != "http" && "$PROTOCOL" != "https" ]]; then
  echo "smoke.sh: --protocol must be 'http' or 'https' (got: $PROTOCOL)" >&2
  exit 2
fi

DASHBOARD_URL="${PROTOCOL}://${DASHBOARD}/api/health"

echo "==> Probing dashboard: ${DASHBOARD_URL}"
# -fsS: fail on >=400, silent except on error, but still show error body.
# -m  : hard cap on the whole transfer so a hung server doesn't wedge CI.
# -o  : capture body so we can grep for ok:true even on a 200.
body_file="$(mktemp)"
trap 'rm -f "$body_file"' EXIT

http_code="$(curl -fsS -m 15 -o "$body_file" -w '%{http_code}' "$DASHBOARD_URL")" || {
  echo "FAIL: dashboard /api/health did not return 2xx"
  echo "----- response body -----"
  cat "$body_file" || true
  echo "-------------------------"
  exit 1
}

if [[ "$http_code" != "200" ]]; then
  echo "FAIL: dashboard /api/health returned HTTP $http_code (expected 200)"
  cat "$body_file"
  exit 1
fi

if ! grep -q '"ok"[[:space:]]*:[[:space:]]*true' "$body_file"; then
  echo "FAIL: dashboard /api/health body did not contain \"ok\": true"
  echo "----- response body -----"
  cat "$body_file"
  echo "-------------------------"
  exit 1
fi

echo "OK:   dashboard /api/health returned 200 with ok:true"

if [[ -z "$SSH_VPS" ]]; then
  echo
  echo "==> Skipping worker /work/health probe (no --ssh-vps given)."
  echo "    The worker is internal-only; it can only be reached from inside the VPS."
  echo "    Re-run with --ssh-vps <user@host> to include it."
  echo
  echo "All smoke checks passed."
  exit 0
fi

echo "==> Probing worker via ${SSH_VPS} (docker compose exec web -> worker:8000/work/health)"

# WORKER_SHARED_SECRET lives in /opt/voxhorizon/.env on the VPS; the web
# container picks it up via env_file. We run curl from inside `web` so
# the call traverses the same Docker network path the dashboard uses.
# Quoting note: outer command goes through ssh -> sh -> docker compose
# exec sh; the single-quoted inner command is what runs inside the
# container. We rely on the worker's bearer secret being present in the
# container's environment (it is, via env_file).
ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$SSH_VPS" \
  "cd /opt/voxhorizon && docker compose exec -T web sh -c 'curl -fsS -m 15 -H \"Authorization: Bearer \$WORKER_SHARED_SECRET\" http://worker:8000/work/health'" \
  > "$body_file" || {
  echo "FAIL: worker /work/health did not return 2xx"
  echo "----- response body -----"
  cat "$body_file" || true
  echo "-------------------------"
  exit 1
}

if ! grep -q '"ok"[[:space:]]*:[[:space:]]*true' "$body_file"; then
  echo "FAIL: worker /work/health body did not contain \"ok\": true"
  echo "----- response body -----"
  cat "$body_file"
  echo "-------------------------"
  exit 1
fi

echo "OK:   worker /work/health returned 200 with ok:true (via $SSH_VPS)"
echo
echo "All smoke checks passed."
