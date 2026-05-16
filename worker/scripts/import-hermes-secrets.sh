#!/usr/bin/env bash
# import-hermes-secrets.sh
# ----------------------------------------------------------------------------
# Imports the credentials that already exist in the upstream Hermes runtime
# into the local worker .env file, and runs quick smoke tests.
#
# Covers:
#   - #5  Kie.ai key (KIE_AI_API_KEY)
#   - #6  Meta Ads + GHL credentials
#   - #74 ElevenLabs key (ELEVENLABS_API_KEY)
#
# Reads from (on Diogo's Mac):
#   ~/.hermes/shared/config/secrets.json
#   ~/.hermes/shared/config/ghl-summary.json
#   ~/.hermes/shared/config/ghl-accounts.json
#
# Writes to:
#   worker/.env  (created from worker/.env.example if missing; appended/updated)
#
# Idempotent: existing keys in worker/.env are updated, not duplicated.
# Gracefully degrades on Windows/WSL where the Hermes config doesn't exist —
# prints a clear "skip on this host" message instead of failing.
#
# Usage:
#   cd <repo>
#   bash worker/scripts/import-hermes-secrets.sh
# ----------------------------------------------------------------------------
set -euo pipefail

log()  { printf "\033[1;34m[hermes-secrets]\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m[ ok            ]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[ warn          ]\033[0m %s\n" "$*"; }
fail() { printf "\033[1;31m[ fail          ]\033[0m %s\n" "$*"; exit 1; }

HERMES_DIR="${HERMES_CONFIG_DIR:-$HOME/.hermes/shared/config}"
SECRETS_JSON="$HERMES_DIR/secrets.json"

# Resolve repo root + worker .env path
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$REPO_ROOT/worker/.env"
ENV_EXAMPLE="$REPO_ROOT/worker/.env.example"

# Ensure worker/.env exists (copy from example if not)
if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -f "$ENV_EXAMPLE" ]]; then
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    log "Created worker/.env from .env.example (chmod 600)"
  else
    fail "Neither $ENV_FILE nor $ENV_EXAMPLE exists. Run from repo root."
  fi
fi

# Idempotent upsert of KEY=VALUE in worker/.env
set_env() {
  local key="$1"
  local value="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    # macOS sed needs -i ''; GNU sed needs -i. Use perl for portability.
    perl -i -pe "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

# --- 0. Skip-on-dev-host guard ----------------------------------------------
if [[ ! -f "$SECRETS_JSON" ]]; then
  warn "Hermes config not found at $SECRETS_JSON"
  warn ""
  warn "This is expected on:"
  warn "  - Pedro's Windows/WSL dev box (no Hermes installed)"
  warn "  - Any host without the upstream voxhorizon-marketing-dept setup"
  warn ""
  warn "On Diogo's Mac the file should exist and contain KIE_AI / META_ADS_API_KEY / etc."
  warn ""
  warn "For local dev: hand-edit worker/.env with placeholder values, or set HERMES_CONFIG_DIR"
  warn "to point at the right path if your Hermes lives elsewhere."
  exit 0
fi

ok "Hermes config found at $SECRETS_JSON"

# --- 1. Read secrets.json -----------------------------------------------------
# Use python3 (always present on macOS + WSL Ubuntu) — no jq dependency.
extract() {
  python3 -c "
import json, sys
try:
    data = json.load(open('$SECRETS_JSON'))
    print(data.get('$1', ''))
except Exception as e:
    print('', file=sys.stderr)
    sys.exit(1)
"
}

KIE_AI_VAL=$(extract "KIE_AI") || true
ELEVENLABS_VAL=$(extract "ELEVENLABS_API_KEY") || \
  ELEVENLABS_VAL=$(extract "ELEVENLABS") || true
META_ADS_VAL=$(extract "META_ADS_API_KEY") || true

# --- 2. Apply to worker/.env --------------------------------------------------
applied=0

if [[ -n "$KIE_AI_VAL" ]]; then
  set_env "KIE_AI_API_KEY" "$KIE_AI_VAL"
  ok "KIE_AI_API_KEY imported"
  applied=$((applied+1))
else
  warn "KIE_AI not found in $SECRETS_JSON (#5 — manual)"
fi

if [[ -n "$ELEVENLABS_VAL" ]]; then
  set_env "ELEVENLABS_API_KEY" "$ELEVENLABS_VAL"
  ok "ELEVENLABS_API_KEY imported"
  applied=$((applied+1))
else
  warn "ELEVENLABS_API_KEY not found in $SECRETS_JSON (#74 — manual)"
fi

if [[ -n "$META_ADS_VAL" ]]; then
  set_env "META_ADS_API_KEY" "$META_ADS_VAL"
  ok "META_ADS_API_KEY imported"
  applied=$((applied+1))
else
  warn "META_ADS_API_KEY not found in $SECRETS_JSON (#6 — manual)"
fi

# --- 3. GHL config -----------------------------------------------------------
GHL_SUMMARY="$HERMES_DIR/ghl-summary.json"
GHL_ACCOUNTS="$HERMES_DIR/ghl-accounts.json"

if [[ -f "$GHL_SUMMARY" ]]; then
  ok "ghl-summary.json present (#6)"
else
  warn "ghl-summary.json missing"
fi
if [[ -f "$GHL_ACCOUNTS" ]]; then
  ok "ghl-accounts.json present (#6)"
else
  warn "ghl-accounts.json missing"
fi

# --- 4. Smoke tests against upstream scripts (best-effort) -------------------
UPSTREAM="${VOXHORIZON_UPSTREAM:-$HOME/github/voxhorizon-marketing-dept}"

if [[ -d "$UPSTREAM" ]]; then
  log "Upstream scripts present at $UPSTREAM"
  if [[ -n "$KIE_AI_VAL" ]]; then
    log "Skipping Kie.ai smoke (would consume API quota; run manually with: cd $UPSTREAM && python3 scripts/creative-tools/kie_generate.py --prompt 'smoke test')"
  fi
  if [[ -n "$META_ADS_VAL" ]]; then
    log "Smoke Meta Ads pull (1d):"
    (cd "$UPSTREAM" && python3 scripts/campaign-ops/meta_campaign_report.py --days 1 2>&1 | head -5) || warn "Meta smoke failed — check META_ADS_API_KEY"
  fi
  if [[ -f "$GHL_SUMMARY" ]] && [[ -f "$GHL_ACCOUNTS" ]]; then
    log "Smoke GHL pipeline pull:"
    (cd "$UPSTREAM" && python3 scripts/campaign-ops/ghl_pipeline.py 2>&1 | head -5) || warn "GHL smoke failed — Cloudflare User-Agent rule may need updating"
  fi
else
  warn "Upstream voxhorizon-marketing-dept repo not found at $UPSTREAM (skipping smoke tests)"
  warn "Set VOXHORIZON_UPSTREAM=/path/to/clone to enable."
fi

# --- 5. Summary ---------------------------------------------------------------
log ""
log "================================================================"
log "Imported $applied secret(s) from Hermes config."
log ""
log "Manual remaining (open the relevant GitHub issue for the runbook):"
log "  #7  Resend — sign up + paste RESEND_API_KEY into Vercel env"
log "  #75 Submagic — sign up + paste SUBMAGIC_API_KEY into worker/.env"
log "  #76 Hyperframes — bootstrap.sh handles install; verify with: cd \$HOME/.voxhorizon/hyperframes-smoke && pnpm exec hyperframes --help"
log "================================================================"
