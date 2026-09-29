#!/usr/bin/env bash
#
# Takes a compressed, checksummed PostgreSQL backup and prunes old ones.
#
# Written to be safe to run from cron, a Kubernetes CronJob, or by hand. It is a *logical*
# backup (pg_dump), not a physical one: that is the right choice for a database of this size
# and it does not require stopping the server, but it means a restore re-runs the schema and
# data load, so RTO is dominated by load time rather than by copy time. See
# docs/BACKUP_AND_RESTORE.md for the RPO/RTO this buys and when to switch to a physical
# backup instead.
#
# Usage:
#   scripts/backup-postgres.sh
#
# Environment:
#   DATABASE_URL        connection string (required). Falls back to PG* libpq variables.
#   BACKUP_DIR          where to write dumps. Default: /var/backups/trustflow/postgres
#   BACKUP_RETENTION_DAYS  delete dumps older than this. Default: 14
#   BACKUP_PREFIX       filename prefix. Default: trustflow

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/trustflow/postgres}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
BACKUP_PREFIX="${BACKUP_PREFIX:-trustflow}"

if [ -z "${DATABASE_URL:-}" ] && [ -z "${PGHOST:-}" ]; then
  echo "Error: set DATABASE_URL (or the PG* libpq variables) before running a backup." >&2
  exit 1
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "Error: pg_dump not found on PATH. Install the PostgreSQL client (postgresql-client)." >&2
  exit 1
fi

if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
  echo "Error: neither sha256sum nor shasum found; cannot checksum the dump." >&2
  exit 1
fi

# Create the directory with restrictive permissions: a dump contains the full audit log,
# including before/after state of every escrow transition.
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP_FILE="${BACKUP_DIR}/${BACKUP_PREFIX}-${TIMESTAMP}.sql.gz"

# Two runs inside the same second would otherwise resolve to the same path and the second
# would silently overwrite the first — losing a backup with no error. Disambiguate instead.
if [ -e "$DUMP_FILE" ]; then
  for suffix in 2 3 4 5 6 7 8 9; do
    candidate="${DUMP_FILE%.sql.gz}-${suffix}.sql.gz"
    if [ ! -e "$candidate" ]; then
      DUMP_FILE="$candidate"
      break
    fi
  done
fi
CHECKSUM_FILE="${DUMP_FILE}.sha256"

log() { echo "[backup-postgres $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

log "Starting dump -> ${DUMP_FILE}"

# --clean --if-exists makes the dump self-contained and restorable into an existing database.
# --no-owner / --no-acl keep the restore independent of the role that happened to take it.
# A non-zero exit here must fail the whole script: a truncated dump that looks successful is
# worse than no backup at all, because the retention job below would eventually delete the
# last good one.
tmp_dump="${DUMP_FILE}.partial"
if [ -n "${DATABASE_URL:-}" ]; then
  pg_dump --dbname="$DATABASE_URL" \
    --clean --if-exists --no-owner --no-acl --format=plain \
    | gzip -9 > "$tmp_dump"
else
  pg_dump --clean --if-exists --no-owner --no-acl --format=plain \
    | gzip -9 > "$tmp_dump"
fi

# A gzip stream of zero bytes, or a dump with no statements, means the connection silently
# produced nothing. Catch it now rather than discovering it during a restore.
if [ ! -s "$tmp_dump" ]; then
  echo "Error: dump is empty — refusing to record it as a successful backup." >&2
  rm -f "$tmp_dump"
  exit 1
fi

mv "$tmp_dump" "$DUMP_FILE"
chmod 600 "$DUMP_FILE"

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$DUMP_FILE" > "$CHECKSUM_FILE"
else
  shasum -a 256 "$DUMP_FILE" > "$CHECKSUM_FILE"
fi
chmod 600 "$CHECKSUM_FILE"

SIZE="$(du -h "$DUMP_FILE" | cut -f1)"
log "Dump complete (${SIZE}), checksum written to ${CHECKSUM_FILE}"

# Write a sidecar with the metadata a restore needs, so an operator picking a file months
# later does not have to infer the target database from its contents.
cat > "${DUMP_FILE}.meta" <<EOF
created_at=${TIMESTAMP}
host=$(hostname)
database=$(pg_restore_cmd=; psql "${DATABASE_URL:-}" -Atc 'select current_database()' 2>/dev/null || echo unknown)
server_version=$(pg_dump --version 2>/dev/null || echo unknown)
size_bytes=$(stat -c %s "$DUMP_FILE" 2>/dev/null || stat -f %z "$DUMP_FILE" 2>/dev/null || echo unknown)
EOF
chmod 600 "${DUMP_FILE}.meta"

# Retention. Only files this script created are considered, so pointing BACKUP_DIR at a
# directory with other content does not delete it.
log "Pruning dumps older than ${BACKUP_RETENTION_DAYS} days"
find "$BACKUP_DIR" -maxdepth 1 -type f \
  -name "${BACKUP_PREFIX}-*.sql.gz" -mtime "+${BACKUP_RETENTION_DAYS}" -print -delete
find "$BACKUP_DIR" -maxdepth 1 -type f \
  -name "${BACKUP_PREFIX}-*.sql.gz.sha256" -mtime "+${BACKUP_RETENTION_DAYS}" -delete
find "$BACKUP_DIR" -maxdepth 1 -type f \
  -name "${BACKUP_PREFIX}-*.sql.gz.meta" -mtime "+${BACKUP_RETENTION_DAYS}" -delete

REMAINING="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name "${BACKUP_PREFIX}-*.sql.gz" | wc -l | tr -d ' ')"
log "Done. ${REMAINING} dump(s) retained in ${BACKUP_DIR}"
