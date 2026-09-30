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

# The dump is written to a sibling `.partial` file and only renamed into place once it has been
# verified, so a crash or a killed process can never leave a half-written file that looks like a
# finished backup. Remove that debris on every exit path — otherwise a nightly job that is OOM
# killed (or interrupted) accumulates one partial dump per run forever: the retention `find`
# below only matches `*.sql.gz`, so these would never be pruned and would eventually fill the
# volume the backups are supposed to be living on.
cleanup_partial() {
  if [ -n "${tmp_dump:-}" ] && [ -e "$tmp_dump" ]; then
    rm -f "$tmp_dump"
  fi
}
trap cleanup_partial EXIT INT TERM

# pg_dump streams its output and gzip compresses it as it arrives, so the dump is never
# buffered in memory — peak RSS is bounded by pg_dump's row buffer, not by database size.
# `pipefail` is what makes a mid-dump connection loss fatal; PIPESTATUS additionally tells us
# *which* side of the pipe failed, so the operator gets an actionable message instead of the
# generic non-zero exit.
if [ -n "${DATABASE_URL:-}" ]; then
  set +e
  pg_dump --dbname="$DATABASE_URL" \
    --clean --if-exists --no-owner --no-acl --format=plain \
    | gzip -9 > "$tmp_dump"
  pipe_status=("${PIPESTATUS[@]}")
  set -e
else
  set +e
  pg_dump --clean --if-exists --no-owner --no-acl --format=plain \
    | gzip -9 > "$tmp_dump"
  pipe_status=("${PIPESTATUS[@]}")
  set -e
fi

pg_dump_status="${pipe_status[0]}"
gzip_status="${pipe_status[1]}"

if [ "$pg_dump_status" -ne 0 ]; then
  echo "Error: pg_dump failed with exit code ${pg_dump_status} — no backup was recorded." >&2
  exit 1
fi

if [ "$gzip_status" -ne 0 ]; then
  echo "Error: gzip failed with exit code ${gzip_status} — the dump could not be compressed." >&2
  exit 1
fi

# `gzip -t` decompresses the stream and verifies its CRC32 and length trailer. Without it a
# dump truncated by a full disk or a killed compressor still passes and would be checksummed
# and retained as though it were restorable; the CRC only fails at restore time, which is the
# worst possible moment to discover it.
if ! gzip -t "$tmp_dump" 2>/dev/null; then
  echo "Error: dump failed gzip integrity verification — refusing to record it as a backup." >&2
  exit 1
fi

# A dump that decompresses to zero bytes means the connection silently produced nothing.
# This has to be measured on the *decompressed* stream: gzip always emits a valid ~20 byte
# header/trailer even for empty input, so testing the compressed file for non-emptiness is
# always true and would record a content-free dump as a successful backup. Decompressing
# streams through `wc -c`, so this stays O(1) in memory.
decompressed_bytes="$(gzip -dc "$tmp_dump" | wc -c | tr -d ' ')"
if [ "${decompressed_bytes:-0}" -eq 0 ]; then
  echo "Error: dump decompresses to zero bytes — refusing to record it as a successful backup." >&2
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
# later does not have to infer the target database from its contents. Resolve the database
# name through the same DATABASE_URL/PG* fallback the dump itself used — passing an empty
# string to `psql` would just fail and report "unknown" for a perfectly healthy database.
if [ -n "${DATABASE_URL:-}" ]; then
  database="$(psql "$DATABASE_URL" -Atc 'select current_database()' 2>/dev/null || echo unknown)"
else
  database="$(psql -Atc 'select current_database()' 2>/dev/null || echo unknown)"
fi

cat > "${DUMP_FILE}.meta" <<EOF
created_at=${TIMESTAMP}
host=$(hostname)
database=${database}
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

# Sweep partial dumps left behind by earlier runs that were killed before their trap could
# fire (SIGKILL, container OOM-kill). They are not matched by the patterns above, so without
# this they would sit in the backup directory forever.
find "$BACKUP_DIR" -maxdepth 1 -type f \
  -name "${BACKUP_PREFIX}-*.sql.gz.partial" -mtime "+${BACKUP_RETENTION_DAYS}" -print -delete

REMAINING="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name "${BACKUP_PREFIX}-*.sql.gz" | wc -l | tr -d ' ')"
log "Done. ${REMAINING} dump(s) retained in ${BACKUP_DIR}"
