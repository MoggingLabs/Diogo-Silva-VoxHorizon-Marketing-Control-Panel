#!/usr/bin/env bash
#
# backup-db.sh - pg_dump the Supabase Postgres database to a compressed
# custom-format archive and upload it to an S3-compatible object store.
#
# This is the script the daily backup workflow (.github/workflows/backup.yml)
# runs, but it is deliberately standalone: an operator can run it from any box
# that has pg_dump + the aws CLI and the env below set. It NEVER touches the
# running VPS stack and NEVER writes to the database.
#
# Part of E5.4 (#520). Pairs with scripts/restore-db.sh and
# docs/runbooks/restore.md. RPO/RTO rationale: docs/adr/0006-backups-and-dr.md.
#
# -----------------------------------------------------------------------------
# Required environment
# -----------------------------------------------------------------------------
#   SUPABASE_DB_URL           Source DSN. Use the Supabase DIRECT connection
#                             (port 5432), NOT the transaction pooler (6543):
#                             pg_dump needs session-level features the pooler
#                             does not expose. Example shape (do not commit a
#                             real one):
#                               postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres
#   BACKUP_S3_BUCKET          Destination bucket name (without s3:// prefix).
#   AWS_ACCESS_KEY_ID         Access key for the object store.
#   AWS_SECRET_ACCESS_KEY     Secret key for the object store.
#
# Optional environment
# -----------------------------------------------------------------------------
#   BACKUP_S3_ENDPOINT        Custom endpoint URL for non-AWS S3 (Backblaze B2,
#                             Cloudflare R2, MinIO). Omit for AWS S3.
#                             e.g. https://s3.us-west-002.backblazeb2.com
#   BACKUP_S3_REGION          Region for the bucket. Default: us-east-1.
#   BACKUP_S3_PREFIX          Key prefix inside the bucket. Default: db.
#   BACKUP_RETENTION_DAYS     If set and > 0, prune dumps older than N days
#                             under the prefix after a successful upload. Prefer
#                             a bucket lifecycle policy; this is a fallback.
#   PGDUMP_JOBS               Reserved. Custom-format directory dumps can be
#                             parallelized; this single-file path does not, so
#                             this is currently informational only.
#
# Exit codes: 0 success; non-zero on any failure (set -euo pipefail).

set -euo pipefail

# -----------------------------------------------------------------------------
# Validate required inputs up front with clear messages. Do not echo any value.
# -----------------------------------------------------------------------------
require() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "error: required environment variable ${name} is not set" >&2
    exit 2
  fi
}

require SUPABASE_DB_URL
require BACKUP_S3_BUCKET
require AWS_ACCESS_KEY_ID
require AWS_SECRET_ACCESS_KEY

for bin in pg_dump aws; do
  if ! command -v "${bin}" >/dev/null 2>&1; then
    echo "error: '${bin}' not found on PATH" >&2
    exit 3
  fi
done

BACKUP_S3_REGION="${BACKUP_S3_REGION:-us-east-1}"
BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-db}"

# aws CLI honours AWS_DEFAULT_REGION; map our var onto it so callers only set
# one name.
export AWS_DEFAULT_REGION="${BACKUP_S3_REGION}"

# Assemble the optional custom-endpoint flag once.
endpoint_args=()
if [ -n "${BACKUP_S3_ENDPOINT:-}" ]; then
  endpoint_args=(--endpoint-url "${BACKUP_S3_ENDPOINT}")
fi

# -----------------------------------------------------------------------------
# Work in a private temp dir, clean up on any exit.
# -----------------------------------------------------------------------------
workdir="$(mktemp -d)"
cleanup() { rm -rf "${workdir}"; }
trap cleanup EXIT

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dump_name="voxhorizon-db-${stamp}.dump"
dump_path="${workdir}/${dump_name}"

echo "==> pg_dump starting (${stamp} UTC)"
# Custom format (-Fc): compressed, selective restore, parallel-restore capable.
# --no-owner / --no-privileges: restore into a target where roles/grants differ
# (a fresh project or a scratch DB) without ownership errors. The Supabase
# schema and its grants are reapplied by migrations on restore, not by the dump.
PGCONNECT_TIMEOUT=30 pg_dump \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges \
  --verbose \
  --file="${dump_path}" \
  "${SUPABASE_DB_URL}"

if [ ! -s "${dump_path}" ]; then
  echo "error: pg_dump produced an empty file" >&2
  exit 4
fi

dump_bytes="$(wc -c <"${dump_path}" | tr -d ' ')"
echo "==> dump written: ${dump_name} (${dump_bytes} bytes)"

# -----------------------------------------------------------------------------
# Integrity check: a valid custom-format archive lists its table of contents.
# A truncated / corrupt dump fails here BEFORE we upload it, so we never ship a
# bad backup that looks fine by size alone.
# -----------------------------------------------------------------------------
echo "==> verifying archive integrity (pg_restore --list)"
if ! pg_restore --list "${dump_path}" >"${workdir}/toc.txt"; then
  echo "error: dump failed integrity check (pg_restore --list)" >&2
  exit 5
fi
toc_lines="$(grep -cv '^;' "${workdir}/toc.txt" || true)"
echo "==> archive OK: ${toc_lines} restorable entries"

# Write a small sidecar manifest so the bucket is self-describing.
manifest="${workdir}/${dump_name}.manifest.txt"
{
  echo "created_utc=${stamp}"
  echo "dump_file=${dump_name}"
  echo "dump_bytes=${dump_bytes}"
  echo "toc_entries=${toc_lines}"
  echo "pg_dump_version=$(pg_dump --version | awk '{print $NF}')"
  echo "format=custom"
} >"${manifest}"

# -----------------------------------------------------------------------------
# Upload dump + manifest. Layout:
#   s3://<bucket>/<prefix>/<YYYY>/<MM>/<dump_name>
# Year/month folders keep the listing manageable and make lifecycle rules easy.
# -----------------------------------------------------------------------------
yyyy="${stamp:0:4}"
mm="${stamp:4:2}"
key_base="${BACKUP_S3_PREFIX}/${yyyy}/${mm}/${dump_name}"
s3_uri="s3://${BACKUP_S3_BUCKET}/${key_base}"

echo "==> uploading to ${s3_uri}"
aws "${endpoint_args[@]}" s3 cp "${dump_path}" "${s3_uri}"
aws "${endpoint_args[@]}" s3 cp "${manifest}" "${s3_uri}.manifest.txt"

# -----------------------------------------------------------------------------
# Post-upload verification: HEAD the object and confirm the remote size matches
# what we uploaded. This catches a silently-truncated upload.
# -----------------------------------------------------------------------------
echo "==> verifying uploaded object"
remote_bytes="$(
  aws "${endpoint_args[@]}" s3api head-object \
    --bucket "${BACKUP_S3_BUCKET}" \
    --key "${key_base}" \
    --query 'ContentLength' --output text
)"
if [ "${remote_bytes}" != "${dump_bytes}" ]; then
  echo "error: remote size ${remote_bytes} != local size ${dump_bytes}" >&2
  exit 6
fi
echo "==> upload verified: ${remote_bytes} bytes at ${s3_uri}"

# -----------------------------------------------------------------------------
# Optional client-side retention prune. Prefer a bucket lifecycle policy; this
# is a fallback for stores without one. Only prunes objects under our prefix
# whose LastModified is older than BACKUP_RETENTION_DAYS.
# -----------------------------------------------------------------------------
if [ -n "${BACKUP_RETENTION_DAYS:-}" ] && [ "${BACKUP_RETENTION_DAYS}" -gt 0 ] 2>/dev/null; then
  echo "==> pruning objects older than ${BACKUP_RETENTION_DAYS} days under ${BACKUP_S3_PREFIX}/"
  cutoff_epoch="$(date -u -d "${BACKUP_RETENTION_DAYS} days ago" +%s 2>/dev/null || true)"
  if [ -z "${cutoff_epoch}" ]; then
    echo "    (skipped: this 'date' does not support relative dates)"
  else
    aws "${endpoint_args[@]}" s3api list-objects-v2 \
      --bucket "${BACKUP_S3_BUCKET}" \
      --prefix "${BACKUP_S3_PREFIX}/" \
      --query 'Contents[].[Key,LastModified]' --output text 2>/dev/null \
      | while read -r key last_modified; do
          [ -n "${key}" ] || continue
          obj_epoch="$(date -u -d "${last_modified}" +%s 2>/dev/null || echo 0)"
          if [ "${obj_epoch}" -ne 0 ] && [ "${obj_epoch}" -lt "${cutoff_epoch}" ]; then
            echo "    deleting ${key}"
            aws "${endpoint_args[@]}" s3 rm "s3://${BACKUP_S3_BUCKET}/${key}"
          fi
        done
  fi
fi

echo "==> backup complete: ${s3_uri}"
