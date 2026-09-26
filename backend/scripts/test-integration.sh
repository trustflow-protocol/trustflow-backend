#!/bin/bash

# Starts the Redis/Postgres dev dependencies (see ../../docker-compose.yml) and runs only the
# *-integration.spec.ts suites against them — the same specs CI's postgres/redis service
# containers back (rate-limit.redis-integration.spec.ts, gig.service.redis-integration.spec.ts,
# nonce-store.redis-integration.spec.ts, database.postgres-integration.spec.ts,
# health.postgres-integration.spec.ts). Every one of those specs already skips itself when
# REDIS_URL/DATABASE_URL is unset, so this script is just a convenience wrapper.

set -e

COMPOSE_FILE="../docker-compose.yml"
REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
DATABASE_URL="${DATABASE_URL:-postgres://trustflow:trustflow@localhost:5432/trustflow_dev}"

if [ ! -f "package.json" ]; then
  echo "Error: must run from the backend/ directory" >&2
  exit 1
fi

echo "Starting Redis and Postgres via docker compose..."
docker compose -f "$COMPOSE_FILE" up -d redis postgres

wait_for_port() {
  local name=$1
  local port=$2
  for i in $(seq 1 30); do
    if (echo > "/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1; then
      echo "$name is accepting connections"
      return 0
    fi
    echo "Waiting for $name on port $port... ($i/30)"
    sleep 1
  done
  echo "Error: $name did not become available in time" >&2
  return 1
}

wait_for_port "Redis" 6379
wait_for_port "Postgres" 5432

echo "Running integration specs..."
REDIS_URL="$REDIS_URL" DATABASE_URL="$DATABASE_URL" npx jest --testPathPattern "integration" "$@"
