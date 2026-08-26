# Transactional Outbox

TrustFlow currently persists mutable application state in Redis; no PostgreSQL data source exists in this service. The outbox therefore uses the same durable store and transaction mechanism already used by the Gig aggregate: Redis `MULTI/EXEC`.

## Atomic write boundary

For every Gig lifecycle transition, the service queues the aggregate write, its indexes, and a serialized `outbox:event:<uuid>` row in a single Redis transaction. The event id is globally unique and its `dedupKey` is stable (`gig:<id>:<event-type>`), so a retry never changes the consumer idempotency key.

Production startup fails without `REDIS_URL`. Development and tests retain an explicitly non-durable in-memory fallback only to keep local workflows simple; it is not a delivery guarantee.

## Relay and at-least-once delivery

`OutboxRelayService` uses sorted-set indexes for efficient due-event and expired-lease queries. A Lua claim script moves a due event from `outbox:pending` to `outbox:processing` atomically and assigns a lease. Expired leases are returned to pending work before each batch, preventing a process crash from losing an event.

After claiming an event, the relay publishes the serialized event to:

- Redis pub/sub channel `trustflow:events:gateway` for the WebSocket gateway
- Redis list `trustflow:events:queue` for queue workers
- registered webhook endpoints

The row is marked `delivered` only after every relay target succeeds. Any failure reschedules the row with exponential backoff (capped at 30 seconds). A destination can receive a duplicate after a partial failure or crash, by design; consumers must persist and compare `dedupKey`.

## PostgreSQL migration path

If TrustFlow adds PostgreSQL domain persistence, retain the `OutboxService` API and replace the Redis implementation with an `INSERT INTO outbox_events ...` in the existing SQL transaction. The hot queries should remain indexed as:

```sql
CREATE INDEX outbox_pending_due_idx
  ON outbox_events (next_attempt_at, id)
  WHERE status = 'pending';

CREATE INDEX outbox_processing_lease_idx
  ON outbox_events (lease_expires_at, id)
  WHERE status = 'processing';
```

Workers should claim rows using `FOR UPDATE SKIP LOCKED`, preserving the same lease and deduplication behavior without table scans.
