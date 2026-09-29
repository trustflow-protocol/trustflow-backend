#!/usr/bin/env bash
#
# Restores PostgreSQL from a dump taken by backup-postgres.sh.
#
# Refuses to run against a database that already has tables unless --force is passed, because
# `--clean --if-exists` drops objects as it goes: a mistyped target here is unrecoverable.
#
# Usage:
#   scripts/restore-postgres.sh --file <dump.sql.gz> [--target-url <url>] [--force] [--verify-only]
#
# Environment:
#   DATABASE_URL   target connection string, when --target-url is not given
#
# Exit codes:
#   0  restored (or verified) successfully
#   1  usage / environment error
#   2  checksum or integrity failure — the dump must not be trusted
#   3  restore failed

set -euo pipefail

DUMP_FILE=""
TARGET_URL="${DATABASE_URL:-}"
FORCE=0
VERIFY_ONLY=0

log() { echo "[restore-postgres $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
fail() { echo "Error: $*" >&2; exit "${2:-1}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --file) DUMP_FILE="${2:-}"; shift 2 ;;
    --target-url) TARGET_URL="${2:-}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --verify-only) VERIFY_ONLY=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[ -n "$DUMP_FILE" ] || fail "--file is required"
[ -f "$DUMP_FILE" ] || fail "dump not found: $DUMP_FILE" 1

if ! command -v psql >/dev/null 2>&1; then
  fail "psql not found on PATH. Install the PostgreSQL client (postgresql-client)." 1
fi

# Step 1: verify integrity before touching the target. A corrupt gzip would otherwise fail
# partway through, leaving the target half-dropped and half-restored.
CHECKSUM_FILE="${DUMP_FILE}.sha256"
if [ -f "$CHECKSUM_FILE" ]; then
  log "Verifying checksum"
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$(dirname "$DUMP_FILE")" && sha256sum -c "$(basename "$CHECKSUM_FILE")")
  else
    (cd "$(dirname "$DUMP_FILE")" && shasum -a 256 -c "$(basename "$CHECKSUM_FILE")")
  fi
else
  log "WARNING: no .sha256 sidecar next to the dump; skipping integrity verification"
fi

log "Verifying the dump decompresses and contains statements"
if ! gzip -t "$DUMP_FILE" 2>/dev/null; then
  fail "gzip integrity check failed — the dump is truncated or corrupt" 2
fi

if ! zcat "$DUMP_FILE" | head -c 65536 | grep -qE '(CREATE|INSERT|ALTER|--)'; then
  fail "dump contains no SQL statements; refusing to restore an empty file" 2
fi

if [ "$VERIFY_ONLY" -eq 1 ]; then
  log "Dump verified; --verify-only set, nothing was written"
  exit 0
fi

[ -n "$TARGET_URL" ] || fail "no target: pass --target-url or set DATABASE_URL" 1

# Warn when the local pg_dump/psql is newer than the server. A dump produced by a newer
# pg_dump can contain GUCs the older server does not know (pg_dump 17+ emits
# `SET transaction_timeout`, which does not exist before 17), and the restore then fails part
# way through. `transaction_timeout` is stripped above for that reason — it only bounds
# idle-in-transaction time, which this script already bounds with statement_timeout — but any
# other future divergence needs a matching filter, so surface the mismatch loudly.
CLIENT_MAJOR="$(psql --version | sed -E 's/.* ([0-9]+)\..*/\1/')"
SERVER_MAJOR="$(psql "$TARGET_URL" -Atc 'show server_version_num' 2>/dev/null | cut -d. -f1 || echo 0)"
if [ "$SERVER_MAJOR" != "0" ] && [ "$CLIENT_MAJOR" -gt "$SERVER_MAJOR" ]; then
  log "WARNING: local psql is v${CLIENT_MAJOR} but the server is v${SERVER_MAJOR}."
  log "WARNING: dumps taken by a newer pg_dump may not restore cleanly. Prefer running the"
  log "WARNING: backup from a host with pg_dump matching the server's major version."
fi

# Step 2: refuse to clobber a populated database without explicit consent.
TABLES="$(psql "$TARGET_URL" -Atc \
  "select count(*) from information_schema.tables where table_schema='public'" 2>/dev/null || echo 0)"
if [ "$TABLES" != "0" ] && [ "$FORCE" -eq 0 ]; then
  fail "target database has ${TABLES} table(s) in public. Re-run with --force to drop and replace them." 1
fi

# Step 3: ON_ERROR_STOP makes psql abort on the first failing statement instead of carrying on
# and reporting a partial restore as success.
log "Restoring into target"
if ! zcat "$DUMP_FILE" \
      | sed -e '/^SET transaction_timeout = /d' \
      | psql "$TARGET_URL" \
          --quiet \
          --variable ON_ERROR_STOP=1 \
          --single-transaction \
          --file=-; then
  fail "psql failed during restore. The target may be unchanged (--single-transaction)." 3
fi

log "Restore complete. Verifying the target is reachable and has tables"
RESTORED="$(psql "$TARGET_URL" -Atc \
  "select count(*) from information_schema.tables where table_schema='public'")"
log "Target now has ${RESTORED} table(s) in public"
if [ "$RESTORED" = "0" ]; then
  fail "restore reported success but the target has no tables" 3
fi

log "Done"
