# Configuration and feature flags

## Configuration is a boot-time snapshot

All environment variables are parsed, validated (with Zod), and cached exactly once at
startup by `validateEnv()` in `backend/src/config/env.config.ts`, which `main.ts` calls
before it creates the Nest application or calls `app.listen()`.

The exported `config` object is a read-only view over that cached result. It never
re-reads `process.env` after validation, and there is no code path that refreshes it
while the process is running.

**Consequence:** changing an environment variable in the deployment's config store while
the app is running has **no effect on the running process**. This includes every
toggle/feature-flag-style variable described below.

## Restart requirement (important)

The following variables behave as feature flags / runtime toggles. They are read from
the environment at boot, so **a restart of every instance is required for a change to
take effect**:

| Variable | Effect |
| --- | --- |
| `SWAGGER_ENABLED` | Serve Swagger UI and the OpenAPI JSON |
| `ALLOW_NO_REDIS` | Allow production boot without `REDIS_URL` (single-node opt-out) |
| `RUN_MIGRATIONS_ON_STARTUP` | Run registered migrations during bootstrap |
| `RATE_LIMIT_ON_REDIS_ERROR` | Fail-open vs fail-closed behaviour during a Redis outage |
| `DB_SSL` / `DB_SSL_REJECT_UNAUTHORIZED` | PostgreSQL TLS behaviour and certificate verification |
| `SHUTDOWN_FORCE_EXIT` | Whether graceful shutdown calls `process.exit()` |
| `NODE_ENV` / `STELLAR_NETWORK` | Environment and network selection (also affect validation rules) |

During a rolling deploy, restarted instances use the new value while the rest still use
the old one. That mixed state is expected. Treat a flag change as a **full rollout** —
restart all instances, and wait for the rollout to finish — before assuming the new
behaviour is active everywhere.

If a flag is flipped in the config store but the running app does not change, this is
not a bug: restart the instances. If you need a flag to take effect without a restart,
use the dynamic-flag approach below instead of an environment variable.

## Live-reloading flags (if restart-free toggling is required)

Environment variables are intentionally static. To support toggling without a restart,
move frequently-changed flags out of the environment and into a dynamically read store.
The recommended option in this codebase is the existing Redis client:

1. Add a `FeatureFlagService` that reads flag values from Redis (e.g. a hash at
   `trustflow:feature-flags`) with a short in-process TTL cache.
2. Inject that service only where a flag is consulted at request time. Keep
   infrastructure-level switches (TLS, network selection, Redis requirement) as env vars
   — those still require a restart by design.
3. Subscribe to a Redis pub/sub channel (or poll on an interval) to invalidate the local
   cache when a flag changes, so all instances converge within the cache TTL.
4. Define a safe default for every flag so a Redis outage leaves the app in a known,
   documented state (fail-open or fail-closed) rather than reading `undefined`.

Until such a service exists, the restart requirement above is the supported behaviour.

## Deliverable content hashes

When a deliverable is submitted with both `content` and a client-supplied `fileHash`, the
server recomputes the CIDv1 (raw, sha2-256) content hash from the decoded bytes. A
`fileHash` in that format that disagrees with the recomputed value is rejected with 400
before any provider is contacted, and the stored CID always comes from the server's pin
result. A `fileHash` supplied without `content` cannot be verified (no bytes to hash), so
it is stored with `PENDING` status.
