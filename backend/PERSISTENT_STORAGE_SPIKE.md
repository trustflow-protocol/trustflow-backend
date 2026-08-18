# Persistent, Multi-Instance-Safe Storage — Spike Findings

**Issue**: #181 - Spike: Persistent, multi-instance-safe storage strategy to replace in-memory service state
**Status**: ✅ Spike complete — recommendation + working prototype
**Estimated Time**: 2-3 days (time-boxed spike)
**Difficulty**: 🟣 Spike

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
| `IpfsPinningService` | `Map<cid, PinRecord>` + `Map<cid, Buffer>` (raw content, for re-pin top-up) | Point lookups by CID, filter by replication status for `RepinWorkerService` | Named in the issue. The `Buffer` content map is the one store here too large/unsuited for a KV cache — flagged in §5. |
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
(at the cost of reintroducing divergence for exactly the outage window — see §5).

**Caveat — `EscrowService` warrants a second look before migrating it.** It's the one store
here backing money-adjacent, audit-sensitive state. Redis gives it multi-instance safety but
not the ACID multi-row transactions, point-in-time recovery, or SQL-based audit querying that a
relational store gives for free. Whether that trade-off is acceptable is a judgment call this
spike deliberately leaves open rather than answers by default — flagged as a blocking unknown
in §5 and left to `EscrowService`'s own follow-up issue (§6) to resolve, rather than assumed
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
level, since — unlike rate limiting or auth challenges — a fallback here silently reintroduces
the exact multi-instance divergence this spike exists to fix, and that's worth paging on, not
just noting.

Tests (`gig.service.spec.ts`) run the entire behavioral suite twice — once against a small
in-memory fake `ioredis` client, once with the client set to `null` (fallback path) — plus one
dedicated test asserting the fallback engages when Redis throws mid-call. This mirrors
`nonce-store.service.spec.ts`'s "with Redis" / "without Redis" structure. No real Redis server
is reachable in CI or this dev environment, so, consistent with the rest of the codebase's
Redis-touching tests, everything here is verified against a mocked `ioredis` client rather than
a live one — flagged in §5.

## 5. Blocking unknowns

- **No live Redis available to validate against in this environment or in CI.** Every test here
  (and every existing Redis-touching test in this repo) mocks the `ioredis` client rather than
  hitting a real server. The `MULTI`/`ZADD`/`ZRANGEBYSCORE` command shapes are standard and
  well-documented, but this prototype has not been run against an actual Redis instance.
- **Redis durability/backup configuration is unverified.** Nothing in this repo pins down
  whether the deployed Redis runs with AOF/RDB persistence, replication, or a backup schedule.
  Treating it as a system of record (rather than a cache) for anything beyond `GigService`
  — especially `EscrowService` — should not proceed until that's confirmed with whoever owns
  the deployment.
- **Single Redis instance is a SPOF** as currently configured (`redis.module.ts` connects to one
  `REDIS_URL`, no Sentinel/Cluster). Acceptable for a prototype; worth revisiting before treating
  Redis as ground truth for money-adjacent state.
- **`EscrowService`'s persistence layer is intentionally left open** (§2) rather than defaulted
  to Redis — needs its own decision, informed by whoever owns the compliance/audit requirements
  around escrow state.
- **`IpfsPinningService`'s raw-content `Buffer` map** (kept so the re-pin worker can retry
  uploads without re-fetching from the original caller) is a poor fit for Redis as a general KV
  store — large binary blobs bloat Redis memory fast. Its own follow-up issue should evaluate
  either dropping the retry-without-refetch behavior or moving raw content to object storage
  (S3-compatible) with only the CID/metadata in Redis.

## 6. Follow-up issues filed

- #187 — Migrate `EscrowService` off in-memory storage, deciding Redis vs. a relational store
  given its money-adjacent/audit-sensitive state (§2, §5).
- #188 — Migrate `UserProfileService` off in-memory storage to Redis, preserving `search()`'s
  current behavior as an in-process scan (§2).
- #189 — Migrate `IpfsPinningService`'s pin registry off in-memory storage to Redis, and resolve
  the raw-content `Buffer` map's storage location separately (§5).
- #190 — Migrate the remaining smaller in-memory stores (`DisputeSagaService`,
  `EscrowReconciliationStateStore`, `EventProcessorService`, `LedgerCursorService`,
  `MigrationStateStore`) to Redis, following the same pattern as this prototype.

(Filed as GitHub issues linked from #181.)
