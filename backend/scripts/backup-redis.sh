#!/usr/bin/env bash
#
# Snapshots Redis and copies the resulting RDB (and AOF files) to the backup directory.
#
# Redis holds every mutable aggregate in this backend — gigs, escrows, nonces, refresh tokens,
# idempotency keys and the outbox. A lost Redis is a total loss of escrow state, so this is not
# optional infrastructure.
#
# The snapshot is taken with BGSAVE, which forks and persists in the background; the script
# then waits for the last save to complete. It does NOT stop Redis, so this is safe to run
# against a live instance. If a consistent point-in-time copy of the AOF is required while
# Redis is serving writes, use `redis-cli BGREWRITEAOF` / a replica instead — RDB is
# fork-consistent but only captures what existed at the fork.
#
# Usage:
#   scripts/backup-redis.sh
#
# Environment:
#   REDIS_URL              connection string. Default: redis://localhost:6379
#   REDIS_CONTAINER        container name to copy files out of. Default: trustflow-redis
#   REDIS_DATA_DIR         in-container data dir. Default: /data
#   BACKUP_DIR             where to write snapshots. Default: /var/backups/trustflow/redis
#   BACKUP_RETENTION_DAYS  delete snapshots older than this. Default: 14

set -euo pipefail

REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
REDIS_CONTAINER="${REDIS_CONTAINER:-trustflow-redis}"
REDIS_DATA_DIR="${REDIS_DATA_DIR:-/data}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/trustflow/redis}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

log() { echo "[backup-redis $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

if ! command -v redis-cli >/dev/null 2>&1; then
  echo "Error: redis-cli not found on PATH. Install the Redis client (redis-tools)." >&2
  exit 1
fi

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SNAPSHOT_DIR="${BACKUP_DIR}/${TIMESTAMP}"

mkdir -p "$SNAPSHOT_DIR"
chmod 700 "$BACKUP_DIR" "$SNAPSHOT_DIR"

log "Requesting BGSAVE"
redis-cli -u "$REDIS_URL" BGSAVE >/dev/null

# Wait for the background save to finish. A second BGSAVE while one is running is rejected
# with "Background save already in progress", so treat that as "wait for the current one".
log "Waiting for the background save to complete"
for i in $(seq 1 120); do
  INFO="$(redis-cli -u "$REDIS_URL" INFO persistence 2>/dev/null || true)"
  IN_PROGRESS="$(printf '%s' "$INFO" | tr -d '\r' | sed -n 's/^rdb_bgsave_in_progress:\([01]\)$/\1/p')"
  LAST_STATUS="$(printf '%s' "$INFO" | tr -d '\r' | sed -n 's/^rdb_last_bgsave_status:\(.*\)$/\1/p')"
  if [ "${IN_PROGRESS:-1}" = "0" ]; then
    if [ "${LAST_STATUS:-ok}" != "ok" ]; then
      echo "Error: last BGSAVE status is '${LAST_STATUS}'." >&2
      exit 1
    fi
    break
  fi
  [ "$i" -lt 120 ] || { echo "Error: BGSAVE did not finish within 120s." >&2; exit 1; }
  sleep 1
done

# Copy via a container when one is available; otherwise save a self-contained RDB with
# redis-cli, which works against a managed/remote Redis too.
if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$REDIS_CONTAINER"; then
  log "Copying dump.rdb and appendonly files from container ${REDIS_CONTAINER}"
  docker cp "${REDIS_CONTAINER}:${REDIS_DATA_DIR}/dump.rdb" "${SNAPSHOT_DIR}/dump.rdb" 2>/dev/null || true
  docker cp "${REDIS_CONTAINER}:${REDIS_DATA_DIR}/appendonlydir" "${SNAPSHOT_DIR}/appendonlydir" 2>/dev/null || true
else
  log "No local container found; writing an RDB snapshot via redis-cli"
  # --rdb writes a point-in-time RDB to stdout without disturbing the server.
  redis-cli -u "$REDIS_URL" --rdb > "${SNAPSHOT_DIR}/dump.rdb"
fi

if [ ! -s "${SNAPSHOT_DIR}/dump.rdb" ]; then
  echo "Error: snapshot is empty — refusing to record it as a successful backup." >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$SNAPSHOT_DIR" && find . -type f -exec sha256sum {} + > manifest.sha256)
else
  (cd "$SNAPSHOT_DIR" && find . -type f -exec shasum -a 256 {} + > manifest.sha256)
fi

KEYS="$(redis-cli -u "$REDIS_URL" DBSIZE 2>/dev/null | tr -d '\r' || echo unknown)"
cat > "${SNAPSHOT_DIR}/meta" <<EOF
created_at=${TIMESTAMP}
dbsize=${KEYS}
source=${REDIS_URL%%@*}|${REDIS_URL##*@}
EOF

log "Snapshot complete: ${SNAPSHOT_DIR} (${KEYS} keys)"

log "Pruning snapshots older than ${BACKUP_RETENTION_DAYS} days"
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime "+${BACKUP_RETENTION_DAYS}" -print -exec rm -rf {} +

log "Done. $(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ') snapshot(s) retained in ${BACKUP_DIR}"
