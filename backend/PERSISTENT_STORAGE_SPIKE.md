# Persistent, Multi-Instance-Safe Storage — Spike Findings

**Issue**: #181 - Spike: Persistent, multi-instance-safe storage strategy to replace in-memory service state
**Status**: ✅ Spike complete — recommendation + working prototype
**Estimated Time**: 2-3 days (time-boxed spike)
**Difficulty**: 🟣 Spike
**⚠️ New production requirement**: as of this PR, `REDIS_URL` must be configured in any
`NODE_ENV=production` deployment — `GigService` now fails app startup rather than silently
falling back to per-instance memory when it's missing (see §6).

## Overview

Every stateful service in this backend keeps its data in a process-local `Map`. That means all
state — gigs, escrows, profiles, pinned CIDs, saga progress, reputation scores, migration/
reconciliation run history, the event-ingestion ledger cursor and dedup log — is lost on
restart and diverges across instances behind a load balancer. This document inventories every
in-memory store found in the codebase, evaluates persistence options against it, recommends
one, and prototypes the recommendation against `GigService` (the smallest/newest domain
service, per the issue).

Distributed locking for the sweep workers (`GigExpiryWorkerService`, `RepinWorkerService`) is
**out of scope here** — it's already tracked as its own issue, #182, filed independently of
this spike and explicitly scoped to be persistence-layer-agnostic. §3 below only confirms the
recommended persistence layer doesn't conflict with #182's approach.

## 1. Inventory of in-memory state

| Service | Store | Access pattern | Notes |
| --- | --- | --- | --- |
| `GigService` | `Map<id, Gig>` | Point lookups by id, filter by creator, filter by status+deadline for the expiry sweep | Named in the issue. **Prototyped below.** |
| `EscrowService` | `Map<id, Escrow>` | Point lookups by id/contractEscrowId, filter by depositor | Named in the issue. Money-adjacent — see §2's caveat. |
| `UserProfileService` | `Map<id, Profile>` + `Map<walletAddress, id>` secondary index | Point lookups, substring search across name/bio/skills | Named in the issue. Substring `search()` doesn't map cleanly onto Redis (see §2). |
| `IpfsPinningService` | `Map<cid, PinRecord>` + `Map<cid, Buffer>` (raw content, for re-pin top-up) | Point lookups by CID, filter by replication status for `RepinWorkerService` | Named in the issue. The `Buffer` content map is the one store here too large/unsuited for a KV cache — flagged in §7. |
| `NonceStoreService` | `Map` (challenge) + `Map` (used-nonce) | Point lookups, TTL-based expiry | **Already partially migrated** — this service already reads/writes Redis with an in-memory fallback (`src/auth/nonce-store.service.ts`). It's the direct precedent this spike's prototype follows. |
| `EventProcessorService` | `Map<eventId, ProcessedEvent>` | Point lookups, dedup check before processing each Soroban event | Reorg-safety dedup log — losing it on restart risks double-processing events across a restart window. |
| `LedgerCursorService` | `Map<contractId, LedgerCheckpoint>` | Point lookups, one row per watched contract | Already keys its Map entries with a `ledger_cursor:` prefix, i.e. it's already shaped like a Redis key — looks like an unfinished migration. |
| `DisputeSagaService` | `Map<sagaId, Saga>` + `Map<escrowId, sagaId>` index | Point lookups, saga step transitions | Orchestrates a multi-step saga; losing state mid-saga on restart leaves it stuck. |
| `ReputationScoreStore` | `Map<address, ScoreRecord>` | Point lookups, full-table scan for leaderboards | Simple KV shape. |
| `EscrowReconciliationStateStore` | `Map<runId, ReconciliationRun>` | Point lookups, sorted-by-time listing | Simple KV shape. |
| `MigrationStateStore` | `Map<runId, MigrationRun>` + `Map<migrationName, activeRunId>` | Point lookups, "is a migration currently running" check | Ironically, the framework that runs schema migrations has no persistent record of having run one. |
| `MigrationRegistryService` | `Map<name, SchemaMigration>` | — | **Out of scope**: this is a registry of migration *definitions* populated from code at boot, not runtime data. Nothing to persist. |

Only `NonceStoreService` (auth) and the rate limiter (`src/common/rate-limit/`, not itself a
domain "service" but the same shape of problem) already use the Redis client wired up in
`src/common/redis/redis.module.ts`. Every other store above is untouched by it.

## 2. Persistence options evaluated

| Option | Fit here |
| --- | --- |
| **Postgres** | Would satisfy every access pattern (including `UserProfileService.search()`'s substring matching, which Postgres handles natively via `ILIKE`/full-text search and Redis does not). But it's **entirely new infrastructure**: no driver, ORM, or connection-pool config exists anywhere in `package.json` today, and none of the inventoried services need cross-entity joins or multi-row transactions that would justify the lift. The `migration` framework (`SchemaMigration`) is already DB-agnostic — it operates against a `targetTable` name with no SQL binding — so adopting it doesn't force Postgres either way. |
| **DynamoDB** | Solves durability and horizontal scale, but is a new managed-service dependency with its own access-pattern-first modeling discipline (single-table design, GSIs) that's a poor match for a five-minute-timeboxed KV need like `LedgerCursorService`. No stronger fit than Redis for anything in the inventory, at higher integration cost. |
| **Redis** | **Recommended.** Already a hard dependency (`REDIS_URL` is documented as required in `.env.example`, currently only exercised by rate limiting) and already has a working, tested integration pattern in this exact codebase: `NonceStoreService` and `RateLimitGuard` both use `REDIS_CLIENT` with atomic Lua scripts for multi-step operations and a graceful in-memory fallback when Redis is unreachable. Every access pattern in the inventory (§1) is a point lookup, a small index/set membership check, or a time/score-ordered range scan — all of which map directly onto Redis strings, sets, and sorted sets. Adopting it for the remaining services is consistent with existing practice, not a new integration. |

### Recommendation

**Redis**, as the default target for migrating the remaining in-memory stores, following the
pattern `NonceStoreService`/`RateLimitGuard` already establish in this codebase: plain
`GET`/`SET`/`MULTI` for entities, sorted sets for time-ordered/range queries (expiry sweeps,
run history), sets for secondary indices, and a documented, error-logged fallback to an
in-memory `Map` when Redis is unreachable so a single instance keeps functioning in isolation
(at the cost of reintroducing divergence for exactly the outage window — see §6, §7).

**Caveat — `EscrowService` warrants a second look before migrating it.** It's the one store
here backing money-adjacent, audit-sensitive state. Redis gives it multi-instance safety but
not the ACID multi-row transactions, point-in-time recovery, or SQL-based audit querying that a
relational store gives for free. Whether that trade-off is acceptable is a judgment call this
spike deliberately leaves open rather than answers by default — flagged as a blocking unknown
in §7 and left to `EscrowService`'s own follow-up issue (§8) to resolve, rather than assumed
here.

**Caveat — `UserProfileService.search()`** does substring matching across `name`, `bio`, and
`skills`. Redis has no native equivalent at this data size without adding RediSearch (a
separate module, not guaranteed available on every Redis deployment). The recommended path is
to keep `search()` doing an in-process scan of `findAll()`'s results after migrating storage —
same behavior as today, just no longer the primary state store — and treat proper search
indexing as a separate, later concern if profile volume ever makes an in-process scan too slow.

## 3. Compatibility with the distributed-lock strategy (#182)

#182 already specifies a Redis-backed lease lock (`SET key value NX PX <ttl>` + renewal) for
`GigExpiryWorkerService`/`RepinWorkerService`, independent of where the swept data itself lives.
Recommending Redis as the persistence layer here uses the same Redis instance and client
(`REDIS_CLIENT`) #182 already depends on — no second infrastructure dependency, no risk of the
two efforts recommending incompatible backends. The two issues can land in either order.

## 4. Prototype: `GigService` migrated to Redis

`GigService` (`src/gig/gig.service.ts`) now stores each gig as `SET gig:{id} <json>`, plus three
index structures written atomically via `MULTI`/`EXEC` alongside the entity write:

- `gigs:index` — sorted set (`score` = `createdAt` epoch ms) for `findAll()` ordering.
- `gigs:by-creator:{address}` — set of ids, for `findByCreator()`.
- `gigs:open:respondBy` — sorted set (`score` = `respondBy` epoch ms), holding only currently-
  `OPEN` gigs. `findExpirable()` is a single `ZRANGEBYSCORE` against it instead of a full scan;
  a gig is removed from it the moment it leaves `OPEN` (accepted/cancelled/expired).

Every method that previously returned synchronously now returns a `Promise` — `GigController`
and `GigExpiryWorkerService` (its only two callers) are updated to `await` them.

Matching `NonceStoreService`'s existing convention, a Redis-unavailable call (null client, or a
thrown error from `ioredis`) falls back to a process-local `Map`, logged at `error` (not `warn`)
level and counted via a metric, since — unlike rate limiting or auth challenges — a fallback
here silently reintroduces the exact multi-instance divergence this spike exists to fix, and
that's worth paging on, not just noting. In production specifically, the fallback is refused
outright rather than engaged — see §6.

`MULTI`/`EXEC` in `ioredis` only rejects the whole call on a queue-time error; a runtime failure
in one queued command instead surfaces as a per-command `[Error, null]` entry in the results
array while `exec()` itself still resolves successfully. `GigService.assertTransactionOk()`
inspects that results array (and treats a `null` result — an aborted `WATCH` — the same way) so
a partially-applied transaction is treated as a failure and triggers the same fallback path,
rather than being silently accepted as a success.

### Test coverage

- `gig.service.spec.ts` runs the entire behavioral suite twice — once against a small in-memory
  fake `ioredis` client, once with the client set to `null` (fallback path) — plus dedicated
  tests asserting the fallback engages (and the fallback metric fires) when: `multi()` throws
  outright, a queued command inside `MULTI`/`EXEC` fails without `exec()` itself rejecting, and
  `exec()` resolves `null`. It also covers the production fail-fast behavior from §6.
- `gig.service.redis-integration.spec.ts` runs a smaller, focused suite against a **real** Redis
  server (no mocking) to validate what the mock can't faithfully reproduce: actual `MULTI`/`EXEC`
  atomicity, actual `ZADD`/`ZRANGEBYSCORE`/`ZREM` sorted-set ordering, and actual `SADD`/`SMEMBERS`
  set semantics. It's gated on `process.env.REDIS_URL` and skips (not fails) when unset, so
  `npm test` still works without a local Redis. CI provides one via a `redis:7-alpine` service
  container (`.github/workflows/backend-ci.yml`) and sets `REDIS_URL` for the test step only.
  Verified locally against a real `redis:7-alpine` container before this was pushed.

### Running it locally

Without Redis — `GigService` runs on its in-memory fallback, same as before this PR:

```bash
cd backend
npm install
npm run dev   # REDIS_URL unset (or Redis unreachable) -> in-memory fallback, logged at error level
```

With Redis — start one, point `REDIS_URL` at it, and gig state now survives a restart and is
shared if you run a second instance on another port against the same Redis:

```bash
docker run -d --rm -p 6379:6379 redis:7-alpine
cd backend
REDIS_URL=redis://localhost:6379 npm run dev
```

To also run the real-Redis integration suite (`gig.service.redis-integration.spec.ts`) locally
instead of relying on CI:

```bash
docker run -d --rm -p 6379:6379 redis:7-alpine
REDIS_URL=redis://localhost:6379 npx jest src/gig
```

## 6. Runtime behavior, observability, and production guidance

**Fallback behavior is now environment-gated**, not just logged. `GigService.onModuleInit()`
throws (failing app startup) if `NODE_ENV=production` and no Redis client is configured — a
production deployment should never silently start diverging state across instances. Outside
production (dev/test), the in-memory fallback still engages so the app runs without a local
Redis. If Redis becomes unreachable *mid-run* in production (as opposed to being unconfigured
at startup), there's no live health check that kills the process — the fallback still engages
per-call for the duration of the outage, logged and counted as below. That's a deliberate
trade-off (continued availability over strict consistency during a live outage) rather than an
oversight, but it means the metric below is the thing that actually catches a live-Redis-outage
window in production, not the startup check.

**Metric**: every fallback increments `gig_persistence_fallback_total{operation="..."}` via the
existing `MetricsService` (`src/monitoring/metrics.service.ts`), exposed at `GET /metrics` in
Prometheus format alongside everything else that service already tracks.

**Alerting guidance**: alert if `gig_persistence_fallback_total` is non-zero and increasing over
a sustained 5-minute window in production. Treat it as multi-instance consistency being at risk
(gigs created/accepted/expired on the affected instance won't be visible to others until Redis
recovers), not as a hard outage — a single blip that self-resolves within the window shouldn't
page. This is a starting point, not a tuned threshold; whoever owns alerting should adjust it
against real traffic patterns once this is live.

## 7. Blocking unknowns

- **Redis durability/backup configuration is unverified.** Nothing in this repo pins down
  whether the deployed Redis runs with AOF/RDB persistence, replication, or a backup schedule.
  Treating it as a system of record (rather than a cache) for anything beyond `GigService`
  — especially `EscrowService` — should not proceed until that's confirmed with whoever owns
  the deployment. Recommend AOF (`appendonly yes`, `everysec` fsync) at minimum for any store
  treated as ground truth — RDB snapshotting alone can lose up to the snapshot interval's worth
  of writes on a crash.
- **Single Redis instance is a SPOF** as currently configured (`redis.module.ts` connects to one
  `REDIS_URL`, no Sentinel/Cluster). Acceptable for a prototype; worth revisiting before treating
  Redis as ground truth for money-adjacent state.
- **Sizing is unestimated.** `GigService` records are small (a few hundred bytes of JSON each),
  so it's a non-issue on its own. That won't necessarily hold for every store in §8's follow-ups
  — `IpfsPinningService`'s metadata in particular should get a rough per-record size × expected
  volume estimate before migrating, given the raw-content concern already flagged below. Ops
  should confirm the deployed Redis's memory ceiling and eviction policy (`maxmemory-policy`)
  before more stores land on it.
- **`EscrowService`'s persistence layer is intentionally left open** (§2) rather than defaulted
  to Redis — needs its own decision, informed by whoever owns the compliance/audit requirements
  around escrow state.
- **`IpfsPinningService`'s raw-content `Buffer` map** (kept so the re-pin worker can retry
  uploads without re-fetching from the original caller) is a poor fit for Redis as a general KV
  store — large binary blobs bloat Redis memory fast. Its own follow-up issue should evaluate
  either dropping the retry-without-refetch behavior or moving raw content to object storage
  (S3-compatible) with only the CID/metadata in Redis.

## 8. Follow-up issues filed

None of these are currently assigned to a specific person — "owner" below means "whoever owns
that domain area," for whoever is triaging the backlog to route accordingly. Priority reflects
risk/blast-radius if left in-memory, not effort.

| Issue | Owner | Priority | Blocks rollout? |
| --- | --- | --- | --- |
| #187 — Migrate `EscrowService` off in-memory storage, deciding Redis vs. a relational store given its money-adjacent/audit-sensitive state (§2, §7) | Whoever owns escrow/compliance | **High** | Yes — recommend resolving before treating Redis as ground truth for any money-adjacent state elsewhere in the backend, since the decision here (Redis vs. relational) may inform the others. |
| #188 — Migrate `UserProfileService` off in-memory storage to Redis, preserving `search()`'s current behavior as an in-process scan (§2) | Whoever owns user-profile | Medium | No |
| #189 — Migrate `IpfsPinningService`'s pin registry off in-memory storage to Redis, and resolve the raw-content `Buffer` map's storage location separately (§7) | Whoever owns IPFS/storage | Medium | No — but the raw-content sub-decision should land before this migrates, not after |
| #190 — Migrate the remaining smaller in-memory stores (`DisputeSagaService`, `EscrowReconciliationStateStore`, `EventProcessorService`, `LedgerCursorService`, `MigrationStateStore`) to Redis, following the same pattern as this prototype | Whoever owns event-ingestion/disputes | Low-medium, can be split into per-store PRs | No, except `EventProcessorService`/`LedgerCursorService`'s reorg-safety semantics should be explicitly re-verified as part of that migration (see the issue's own acceptance criteria) |

(Filed as GitHub issues linked from #181.)
