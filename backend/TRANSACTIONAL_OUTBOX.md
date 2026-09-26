# Transactional Outbox

TrustFlow currently persists mutable application state in Redis; no PostgreSQL data source exists in this service. The outbox therefore uses the same durable store and transaction mechanism already used by the Gig aggregate: Redis `MULTI/EXEC`.

## Event Catalog

For a complete list of all events emitted through the outbox, their payload shapes, and delivery mechanisms, see [API_DOCUMENTATION.md § Webhook Events and Outbox Catalog](./API_DOCUMENTATION.md#-webhook-events-and-outbox-catalog).

### Outbox Event Envelope

Events stored in Redis carry this structure (serialized as JSON in `outbox:event:<uuid>`):

```typescript
{
  id: string;                    // Globally unique event ID
  dedupKey: string;              // Stable consumer deduplication key (e.g., "gig:gig-123:gig.created")
  type: string;                  // Event type (e.g., "gig.created", "dispute.escalated")
  aggregateType: string;         // Aggregate root (e.g., "gig", "dispute_saga")
  aggregateId: string;           // Aggregate ID (e.g., gig ID, dispute saga ID)
  payload: unknown;              // Event-specific data (shape varies by event type)
  status: 'pending' | 'processing' | 'delivered';
  attempts: number;              // Retry attempt count
  nextAttemptAt: number;         // Unix timestamp (ms) of next retry attempt
  createdAt: string;             // ISO 8601 timestamp
  deliveredAt?: string;          // ISO 8601 timestamp (set when status transitions to 'delivered')
  lastError?: string;            // Error message from last failed delivery attempt
}
```

### Relay Destinations

After claiming a due event, `OutboxRelayService` publishes to three destinations:

1. **WebSocket Gateway** (`trustflow:events:gateway` channel)  
   - Consumers: `MilestoneNotificationsGateway` subscribes and broadcasts to connected WebSocket clients.
   - Use case: Real-time UI updates.

2. **Worker Queue** (`trustflow:events:queue` list)  
   - Consumers: Background workers (cron jobs, listeners) that react to events asynchronously.
   - Use case: Long-running tasks, external integrations.

3. **Registered Webhooks**  
   - Consumers: External systems (subscriber endpoints) that registered via `POST /webhooks`.
   - Use case: Third-party event notifications, audit logging, downstream systems.

All three receive the same `OutboxEvent` structure wrapped in the webhook payload envelope (see [API_DOCUMENTATION.md § Webhook Payload Envelope](./API_DOCUMENTATION.md#webhook-payload-envelope)).

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
