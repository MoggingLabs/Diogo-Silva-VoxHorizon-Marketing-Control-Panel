#!/usr/bin/env bash
#
# restore-db.sh - download a pg_dump archive from the off-box object store and
# restore it into a TARGET Postgres database.
#
# This is the recovery counterpart to scripts/backup-db.sh. It is used in two
# situations:
#   1. A real disaster: restore the latest dump into a fresh Supabase project
#      (or any Postgres) to bring the system back. See docs/runbooks/restore.md.
#   2. The quarterly restore drill: restore into a throwaway scratch database to
#      prove the backups are actually restorable. See the drill checklist in
#      docs/runbooks/restore.md.
#
# SAFETY
#   - This script WRITES to TARGET_DB_URL. It refuses to run unless you pass
#     --confirm, and it loudly prints the target host first.
#   - NEVER point TARGET_DB_URL at the live production database during a drill.
#     The whole point of the drill is to restore into a scratch DB.
#   - It NEVER writes to the backup bucket and NEVER touches the VPS stack.
#
# Part of E5.4 (#520).
#
# -----------------------------------------------------------------------------
# Required environment
# -----------------------------------------------------------------------------
#   TARGET_DB_URL             Destination DSN to restore INTO. For a drill this
#                             is a scratch database; for a real recovery it is
#                             the new project's direct connection (port 5432).
#   BACKUP_S3_BUCKET          Bucket holding the dumps.
#   AWS_ACCESS_KEY_ID         Access key for the object store.
#   AWS_SECRET_ACCESS_KEY     Secret key for the object store.
#
# Optional environment
# -----------------------------------------------------------------------------
#   BACKUP_S3_ENDPOINT        Custom S3 endpoint (Backblaze B2 / R2 / MinIO).
#   BACKUP_S3_REGION          Region. Default: us-east-1.
#   BACKUP_S3_PREFIX          Key prefix. Default: db.
#   RESTORE_JOBS              Parallel restore workers (pg_restore -j). Default 2.
#
# Usage
# -----------------------------------------------------------------------------
#   restore-db.sh --confirm                  Restore the LATEST dump.
#   restore-db.sh --confirm --key <s3-key>   Restore a specific object key.
#   restore-db.sh --list                     List available dumps and exit.
#   restore-db.sh --dry-run                  Resolve + download + verify only;
#                                            do NOT write to the target.
#
# Exit codes: 0 success; non-zero on any failure (set -euo pipefail).

set -euo pipefail

# -----------------------------------------------------------------------------
# Arguments.
# -----------------------------------------------------------------------------
CONFIRM=false
DRY_RUN=false
LIST_ONLY=false
EXPLICIT_KEY=""

usage() {
  sed -n '2,48p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --confirm) CONFIRM=true ;;
    --dry-run) DRY_RUN=true ;;
    --list) LIST_ONLY=true ;;
    --key)
      shift
      EXPLICIT_KEY="${1:-}"
      [ -n "${EXPLICIT_KEY}" ] || { echo "error: --key needs a value" >&2; exit 2; }
      ;;
    -h | --help) usage 0 ;;
    *)
      echo "error: unknown argument '$1'" >&2
      usage 2
      ;;
  esac
  shift
done

# -----------------------------------------------------------------------------
# Validate inputs.
# -----------------------------------------------------------------------------
require() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "error: required environment variable ${name} is not set" >&2
    exit 2
  fi
}

require BACKUP_S3_BUCKET
require AWS_ACCESS_KEY_ID
require AWS_SECRET_ACCESS_KEY
# TARGET_DB_URL is only required when we are actually going to restore.
if [ "${LIST_ONLY}" = false ] && [ "${DRY_RUN}" = false ]; then
  require TARGET_DB_URL
fi

for bin in pg_restore aws; do
  if ! command -v "${bin}" >/dev/null 2>&1; then
    echo "error: '${bin}' not found on PATH" >&2
    exit 3
  fi
done

BACKUP_S3_REGION="${BACKUP_S3_REGION:-us-east-1}"
BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-db}"
RESTORE_JOBS="${RESTORE_JOBS:-2}"
export AWS_DEFAULT_REGION="${BACKUP_S3_REGION}"

endpoint_args=()
if [ -n "${BACKUP_S3_ENDPOINT:-}" ]; then
  endpoint_args=(--endpoint-url "${BACKUP_S3_ENDPOINT}")
fi

# -----------------------------------------------------------------------------
# --list: show available dumps (newest last) and exit.
# -----------------------------------------------------------------------------
if [ "${LIST_ONLY}" = true ]; then
  echo "==> dumps under s3://${BACKUP_S3_BUCKET}/${BACKUP_S3_PREFIX}/ (oldest first):"
  # SC2016: the backticks here are JMESPath literal syntax for the aws CLI, not
  # shell command substitution. Single quotes are intentional - the shell must
  # NOT touch this string.
  # shellcheck disable=SC2016
  aws "${endpoint_args[@]}" s3api list-objects-v2 \
    --bucket "${BACKUP_S3_BUCKET}" \
    --prefix "${BACKUP_S3_PREFIX}/" \
    --query 'sort_by(Contents[?ends_with(Key, `.dump`)], &LastModified)[].[LastModified,Key]' \
    --output text
  exit 0
fi

# -----------------------------------------------------------------------------
# Resolve which object to restore: explicit --key, else the newest .dump.
# -----------------------------------------------------------------------------
if [ -n "${EXPLICIT_KEY}" ]; then
  key="${EXPLICIT_KEY}"
else
  echo "==> resolving latest dump under ${BACKUP_S3_PREFIX}/"
  # shellcheck disable=SC2016  # backticks are JMESPath literals for aws, not shell.
  key="$(
    aws "${endpoint_args[@]}" s3api list-objects-v2 \
      --bucket "${BACKUP_S3_BUCKET}" \
      --prefix "${BACKUP_S3_PREFIX}/" \
      --query 'sort_by(Contents[?ends_with(Key, `.dump`)], &LastModified)[-1].Key' \
      --output text
  )"
  if [ -z "${key}" ] || [ "${key}" = "None" ]; then
    echo "error: no .dump objects found under s3://${BACKUP_S3_BUCKET}/${BACKUP_S3_PREFIX}/" >&2
    exit 4
  fi
fi
echo "==> selected: s3://${BACKUP_S3_BUCKET}/${key}"

# -----------------------------------------------------------------------------
# Download to a private temp dir.
# -----------------------------------------------------------------------------
workdir="$(mktemp -d)"
cleanup() { rm -rf "${workdir}"; }
trap cleanup EXIT

dump_path="${workdir}/$(basename "${key}")"
echo "==> downloading"
aws "${endpoint_args[@]}" s3 cp "s3://${BACKUP_S3_BUCKET}/${key}" "${dump_path}"

if [ ! -s "${dump_path}" ]; then
  echo "error: downloaded dump is empty" >&2
  exit 5
fi

# Integrity check before we touch the target.
echo "==> verifying archive integrity (pg_restore --list)"
if ! pg_restore --list "${dump_path}" >/dev/null; then
  echo "error: downloaded dump failed integrity check" >&2
  exit 6
fi
echo "==> archive OK"

# -----------------------------------------------------------------------------
# --dry-run stops here: we proved the dump exists, downloads, and is a valid
# archive, without writing anything.
# -----------------------------------------------------------------------------
if [ "${DRY_RUN}" = true ]; then
  echo "==> dry run: dump resolved, downloaded, and verified. Not restoring."
  exit 0
fi

# -----------------------------------------------------------------------------
# Guard: a restore overwrites the target. Demand --confirm and show the host.
# Print only the host:port/db, never the password embedded in the DSN.
# -----------------------------------------------------------------------------
target_safe="$(printf '%s' "${TARGET_DB_URL}" | sed -E 's#://[^@]+@#://***@#')"
echo ""
echo "  RESTORE TARGET: ${target_safe}"
echo ""
if [ "${CONFIRM}" != true ]; then
  echo "error: refusing to restore without --confirm" >&2
  echo "       re-run with --confirm once you have verified the target above is" >&2
  echo "       a scratch / recovery database and NOT live production." >&2
  exit 7
fi

# -----------------------------------------------------------------------------
# Restore. --clean --if-exists drops objects before recreating them so a
# restore into a non-empty scratch DB is repeatable. --no-owner / --no-acl
# because the dump was taken that way (Supabase roles/grants come from
# migrations, not the dump). pg_restore exits non-zero on hard errors; minor
# "already exists" noise on a fresh DB is normal and surfaced in the log.
# -----------------------------------------------------------------------------
echo "==> restoring (jobs=${RESTORE_JOBS})"
pg_restore \
  --dbname="${TARGET_DB_URL}" \
  --clean \
  --if-exists \
  --no-owner \
  --no-acl \
  --jobs="${RESTORE_JOBS}" \
  --verbose \
  "${dump_path}"

echo "==> restore complete into ${target_safe}"
echo "    Next: run application smoke checks. For a drill, record the result in"
echo "    the quarterly checklist in docs/runbooks/restore.md, then drop the"
echo "    scratch database."
