# Transaction Boundaries

Where TrustFlow's multi-step writes begin and end, and what happens when one of the steps
fails. Written after the atomicity review that found multi-step operations reporting success
for writes that were only half applied.

## There is no ORM

The original issue for this work asked to "wrap related operations in TypeORM transactions".
**TypeORM is not used anywhere in this backend, and never has been** — there is no `typeorm`
dependency, no `DataSource`, no `@Entity`, and no `Repository`. Adopting an ORM would be new
infrastructure plus a rewrite of every aggregate, not a wrapper.

What actually persists mutable state:

| Store | Driver | Used for |
| --- | --- | --- |
| Redis | `ioredis` | Gigs, escrows, nonces, refresh tokens, rate limits, idempotency keys, the outbox |
| PostgreSQL | `pg` (raw pool) | The `audit_logs` table only |

So "a transaction" here means a Redis `MULTI`/`EXEC`, and the guarantees have to be stated in
those terms rather than assumed from ACID.

## What `MULTI`/`EXEC` does and does not give you

Guaranteed:

- Every queued command runs, in order, on a single connection.
- No other client's command interleaves between them.

**Not** guaranteed:

- **Rollback.** If command 3 of 5 fails, commands 1 and 2 are already applied. Redis has no
  compensating action. This is the single most important caveat in this document.
- `exec()` may *resolve* with a per-command `[Error, result]` array rather than reject. A
  runtime error in one command does not reject the promise.
- `exec()` returns `null` when the transaction is aborted, e.g. a `WATCH` conflict.

Because of the first point, a partially applied `MULTI` leaves genuinely inconsistent state —
typically the entity hash written while a secondary index was not. The response to that must
**not** be "carry on", because the store can no longer be reconciled from the caller's side.

## The rule

`assertTransactionApplied()` (`backend/src/common/redis/redis-transaction.ts`) inspects every
`exec()` result and throws `RedisTransactionError` on a per-command failure or an abort.

Services then apply one rule, uniformly:

| Failure | Meaning | Response |
| --- | --- | --- |
| Connectivity (`ECONNREFUSED`, client gone) | Nothing was applied | May degrade to the in-memory store; `*_persistence_fallback_total` incremented |
| `RedisTransactionError`, reason `command-failed` | Part may already be durable | **Never degrade.** Raise `503`, increment `escrow_transaction_inconsistent_total` |
| `RedisTransactionError`, reason `aborted` | Nothing was applied | Retry / surface, but do not treat as success |

Before this, `EscrowService` caught the error it had just raised in order to detect the
integrity failure, logged it, wrote the entity to a process-local `Map`, and returned the
escrow as if saved. The HTTP caller received a `2xx` for a write that was half applied. That is
the "gig created but escrow fails" shape, inverted.

Classifying on a `RedisTransactionError` type rather than on message text also means rewording
an error message can no longer silently disable the check — which it could when
`GigService` matched `err.message.includes('transaction aborted')`.

## Boundary map

### `EscrowService`

| Operation | Atomic unit | Notes |
| --- | --- | --- |
| `create` | `SET escrow:<id>`, `ZADD escrows:index`, `SADD escrows:by-depositor:<addr>`, outbox event + `outbox:pending` | One `MULTI` |
| `persist` (fund/release/cancel/split/raiseDispute/correctStatus) | `SET escrow:<id>`, outbox event + `outbox:pending` | One `MULTI`. No index command: `id` and `depositor` are immutable |
| `applyChainState` | `SET escrow:<id>` | Deliberately emits **no** outbox event — the reconciler repairs drift and must not produce a second domain event |
| `linkContractEscrowId` | `SET escrow:<id>`, `SET escrows:by-contract:<cid>` | One `MULTI` |
| `createFromChainState` | `SET`, `ZADD`, `SADD`, `SET contract→id` | One `MULTI`, 4 commands |

**Not atomic, by design:** the audit write in `release` / `raiseDispute`.

```
persist(escrow, ESCROW_RELEASED)      ← Redis MULTI (state + event commit together)
await audit.logOperation(...)         ← separate PostgreSQL INSERT, outside any transaction
```

There is no 2PC between Redis and PostgreSQL, and adding one is not justified here. The audit
row is best-effort by design and swallows its own errors; a state change can therefore commit
without a matching audit row. If a deployment requires an audit trail to be mandatory, the
audit table needs to move into the same store as the aggregate — see "Known gaps".

Note also that `AuditService` is a no-op when `DATABASE_URL` is unset, which is the default.
In a Redis-only deployment, `release()` and `raiseDispute()` write **no** audit record at all.

### `GigService`

| Operation | Atomic unit |
| --- | --- |
| `create` | `SET`, `ZADD gigs:index`, `ZADD gigs:open:respondBy`, `SADD gigs:by-creator:<addr>`, outbox event + pending |
| `persistResolved` (accept/cancel/expire) | `SET`, `ZREM gigs:open:respondBy`, outbox event + pending |
| `persistGig` (update) | `SET`, `ZADD gigs:open:respondBy` — **no** event: not a lifecycle transition |
| `remove` | `DEL`, `ZREM` ×2, `SREM` |

**Not atomic:** search-cache invalidation. `invalidateSearchCache()` runs *after* the
committing `MULTI`, because invalidating before the write would let a concurrent read
repopulate the cache from pre-commit state. The window is the standard cache-aside race, and
`writeSearchCache` (`SET` then `SADD`) is itself two round trips, so a cache key written
between the invalidation's `SMEMBERS` and `DEL` is orphaned. Acceptable for a search index;
worth knowing it is not exact.

### Concurrency

`GigService` guards its read-modify-write transitions with `WATCH` + retry
(`mutateWithRetry`, 3 attempts, then `409`). `EscrowService` does **not** — see "Known gaps".

## Known gaps

These are real and deliberately not addressed here, because each is a schema or product change
rather than a bug fix.

1. **`EscrowService` has no optimistic concurrency.** `fund`, `release`, `cancel`, `split` and
   `raiseDispute` are a bare read → mutate → write. Two concurrent `release()` calls both read
   a `disputed` escrow, both pass their guards, and the second write silently clobbers the
   first. There is no `version` field and no `WATCH`. `GigService` solved the identical problem
   with `mutateWithRetry`; porting it is the single highest-value follow-up here, and it
   matters most for `release`, which moves money.

2. **The in-memory fallback is not a safe degraded mode for either aggregate.** It refuses to
   start in production (`onModuleInit` throws without Redis), but in dev/test it is reachable
   after a connectivity error, and state written there is invisible to every other instance and
   lost on restart.

3. **A partially applied `MULTI` is detected but not repaired.** The write is refused and
   `escrow_transaction_inconsistent_total` increments, which is the alert signal, but nothing
   reconciles the already-applied commands. `EscrowReconciliationService` is the intended
   repair path for chain-vs-DB drift; it does not cover Redis index drift.

4. **Redis durability is a deployment concern.** A `MULTI` that has been `EXEC`'d is only as
   durable as Redis's own persistence configuration. See
   [`BACKUP_AND_RESTORE.md`](./BACKUP_AND_RESTORE.md) for the AOF/RDB and backup setup — a
   transaction boundary guarantee is meaningless without it.

## Verifying a change here

- `backend/src/common/redis/redis-transaction.spec.ts` — the `MULTI` failure taxonomy.
- `backend/src/escrow/escrow-transaction-atomicity.spec.ts` — no operation reports success for
  a non-atomic write, and none of them fall back to memory.
- `backend/src/escrow/escrow.service.spec.ts` — the connectivity-vs-integrity split.
- `backend/src/gig/gig.service.spec.ts` — retry-then-`409` on conflict.

Against a real Redis (`REDIS_URL=redis://localhost:6379 npm run test:integration`), the
`gig.service.redis-integration.spec.ts` suite exercises the same `MULTI` paths without mocks.
