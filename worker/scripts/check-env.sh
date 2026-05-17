#!/usr/bin/env bash
# check-env.sh
# ----------------------------------------------------------------------------
# Preflight: fail fast if any env var declared in worker/.env.example is not
# set in the running environment.
#
# Reads worker/.env.example (or the path passed as $1), parses every
# uncommented `KEY=` line, and checks that the running shell actually has each
# var set to a non-empty value.
#
# Exits non-zero with a clear listing of which vars are missing. Designed to
# be invoked at container start (docker compose entrypoint) so the worker
# never boots with a half-configured environment.
#
# Usage:
#   bash worker/scripts/check-env.sh                       # uses worker/.env.example
#   bash worker/scripts/check-env.sh path/to/other.env     # explicit path
# ----------------------------------------------------------------------------
set -euo pipefail

EXAMPLE_FILE="${1:-worker/.env.example}"

if [[ ! -f "$EXAMPLE_FILE" ]]; then
  echo "ERROR: env example file not found: $EXAMPLE_FILE" >&2
  exit 2
fi

missing=()
while IFS= read -r line || [[ -n "$line" ]]; do
  # Skip blank lines and comments (with optional leading whitespace)
  [[ -z "${line//[[:space:]]/}" ]] && continue
  [[ "$line" =~ ^[[:space:]]*# ]] && continue

  # Extract the KEY before the first '=' and trim whitespace
  key="${line%%=*}"
  key="${key#"${key%%[![:space:]]*}"}"
  key="${key%"${key##*[![:space:]]}"}"

  # Skip lines without an '=' (defensive) or that don't look like KEY=...
  [[ -z "$key" ]] && continue
  [[ "$key" == "$line" ]] && continue

  # Check the running env. Indirect expansion `${!key:-}` reads the variable
  # named by $key; empty string if unset or empty.
  if [[ -z "${!key:-}" ]]; then
    missing+=("$key")
  fi
done < "$EXAMPLE_FILE"

if (( ${#missing[@]} > 0 )); then
  echo "ERROR: missing required env vars (declared in $EXAMPLE_FILE):" >&2
  printf '  - %s\n' "${missing[@]}" >&2
  exit 1
fi

echo "env OK (${EXAMPLE_FILE})"
