# TrustFlow API Documentation

**Version**: 1.0.0  
**License**: MIT

---

## 🚀 Quick Start

### Access Interactive Documentation

Once the server is running, access the Swagger UI at:

```
http://localhost:3001/api/docs
```

### OpenAPI JSON Specification

The raw OpenAPI specification is available at:

```
http://localhost:3001/api/docs-json
```

---

## 📚 API Overview

The TrustFlow Backend API provides off-chain services for the TrustFlow gig economy platform. It handles:

- **Authentication**: Wallet-based JWT authentication using Stellar signatures
- **Escrow Management**: Create, manage, and release escrow vaults
- **Dispute Resolution**: Raise disputes and trigger juror notifications
- **Webhooks**: Register endpoints to receive event notifications
- **Monitoring**: Health checks and Prometheus metrics
- **IPFS Pinning**: Pin deliverables across multiple IPFS providers with content-hash verification, automatic failover, and a background re-pin worker for durability
- **Admin Analytics**: Read-only system-wide dashboards for protocol admins, aggregating escrow, gig, dispute, reputation, migration, and reconciliation state

---

## 🔐 Authentication

### Wallet-Based Authentication Flow

1. **Get Challenge**: `GET /auth/challenge?address=YOUR_ADDRESS`
   - Receive a challenge message to sign

2. **Sign with Wallet**: Sign the challenge using your Stellar wallet

3. **Verify Signature**: `POST /auth/verify`

   ```json
   {
     "address": "GXXXXX...",
     "signature": "base64_signature..."
   }
   ```

4. **Receive JWT Token**: Use this token in the `Authorization` header
   ```
   Authorization: Bearer YOUR_JWT_TOKEN
   ```

---

## 🛡️ Distributed Rate Limiting

All non-monitoring endpoints are protected by a Redis-backed distributed token bucket so limits remain coordinated across multiple API nodes.

- **Per-IP limits**: Every request consumes from a route-specific bucket keyed by client IP.
- **Per-wallet limits**: Requests that include wallet identity consume a second route-specific bucket keyed by wallet address. Wallet identity is read from JWT user data, request body, query string, or route params.
- **Abuse detection**: Empty-bucket attempts are tracked in a Redis sorted set over a sliding abuse window.
- **Lockouts**: Repeated violations create temporary Redis lockout keys and return `429 Too Many Requests` without consuming more bucket state.

### Rate Limit Response

```json
{
  "statusCode": 429,
  "message": "Too many requests - rate limit exceeded",
  "retryAfter": 30,
  "scope": "wallet:gabc123"
}
```

### Configuration

```env
REDIS_URL=redis://localhost:6379
RATE_LIMIT_ABUSE_WINDOW_SECONDS=300
RATE_LIMIT_ABUSE_THRESHOLD=5
RATE_LIMIT_LOCKOUT_SECONDS=900
```

`/health` and `/metrics` are exempt through `@SkipRateLimit()`.

---

## 🔁 Idempotency Keys

Mutating endpoints that create a resource (currently `POST /gigs` and `POST /escrows`) accept an
optional `Idempotency-Key` header so retries — e.g. after a client timeout — don't create
duplicate resources.

## 🌐 Stellar RPC Failover

The TrustFlow backend implements automatic failover for Stellar RPC endpoints to ensure high availability. When the primary RPC endpoint becomes unavailable, the system automatically switches to configured fallback endpoints.

### How It Works

1. **Multiple Endpoint Configuration**: Configure comma-separated Horizon and Soroban RPC endpoints in `STELLAR_HORIZON_ENDPOINTS` and `SOROBAN_RPC_ENDPOINTS` environment variables.

2. **Health Monitoring**: Regular health checks (every 30 seconds) monitor all configured endpoints.

3. **Automatic Failover**: If the current endpoint fails 3 consecutive health checks, the system automatically switches to the next healthy endpoint.

4. **Retry Logic**: All Stellar operations include automatic retry with exponential backoff across available endpoints.

5. **Monitoring**: The `/rpc-status` endpoint provides real-time visibility into endpoint health and current failover state.

### Configuration Example

```env
# Primary endpoint + fallbacks
STELLAR_HORIZON_ENDPOINTS=https://horizon-testnet.stellar.org,https://testnet.stellar.org,https://horizon-futurenet.stellar.org
SOROBAN_RPC_ENDPOINTS=https://soroban-testnet.stellar.org,https://rpc-testnet.stellar.org
```

### Checking RPC Status

```bash
curl -X GET http://localhost:3001/rpc-status \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response**:

```json
{
  "currentHorizonEndpoint": "https://horizon-testnet.stellar.org",
  "currentSorobanEndpoint": "https://soroban-testnet.stellar.org",
  "horizonEndpoints": [
    {
      "url": "https://horizon-testnet.stellar.org",
      "healthy": true,
      "lastChecked": "2024-01-01T00:00:00.000Z",
      "failureCount": 0
    },
    {
      "url": "https://testnet.stellar.org",
      "healthy": true,
      "lastChecked": "2024-01-01T00:00:00.000Z",
      "failureCount": 0
    }
  ],
  "sorobanEndpoints": [
    {
      "url": "https://soroban-testnet.stellar.org",
      "healthy": true,
      "lastChecked": "2024-01-01T00:00:00.000Z",
      "failureCount": 0
    }
  ],
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### Client usage

```bash
curl -X POST https://api.example.com/escrows \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{ "depositor": "G...", "beneficiary": "G...", "amountXLM": "100" }'
```

- Generate a fresh, unique key (a UUID is recommended) **per logical operation**, not per HTTP
  attempt — reuse the same key when retrying the same request.
- The key is scoped to the specific endpoint (method + route), so the same key value can safely
  be reused across different endpoints (e.g. once for `POST /gigs` and separately for
  `POST /escrows`) without colliding.

### Behavior

| Situation | Response |
|---|---|
| No `Idempotency-Key` header | Request is processed normally; not cached. |
| First request with a given key | Request is processed; the response is cached. |
| Retry with the same key **and the same body** | The original cached response is replayed (same status code and body) — the handler does not run again. |
| Retry with the same key **and a different body** | `422 Unprocessable Entity` — the key has already been used for a different payload. |
| Concurrent request with the same key while the first is still in flight | `409 Conflict` — a request with this key is already being processed; wait and retry rather than assuming failure. |

Cached responses are stored in Redis for `IDEMPOTENCY_KEY_TTL_SECONDS` (default 24h). Keys are
claimed atomically (`SET NX`), so concurrent duplicate requests cannot both create a resource. If
Redis is unavailable, idempotency protection is skipped and requests are processed normally
(fail-open) rather than blocking traffic.

Response bodies are cached in full, so avoid decorating `@Idempotent()` onto endpoints that return
very large or streamed payloads.

### Using Authentication in Swagger UI

1. Get your challenge and sign it
2. Verify and receive a JWT token
3. Click the 🔒 "Authorize" button in Swagger UI
4. Enter your token (without "Bearer" prefix)
5. All protected endpoints will now include your auth token

---

## 📖 API Endpoints

### Authentication

| Method | Endpoint          | Description                         |
| ------ | ----------------- | ----------------------------------- |
| GET    | `/auth/challenge` | Get authentication challenge        |
| POST   | `/auth/verify`    | Verify wallet signature and get JWT |

### Escrow Management

| Method | Endpoint                      | Description              |
| ------ | ----------------------------- | ------------------------ |
| POST   | `/escrows`                    | Create new escrow        |
| GET    | `/escrows/:id`                | Get escrow by ID         |
| GET    | `/escrows/depositor/:address` | Get escrows by depositor |
| POST   | `/escrows/:id/release`        | Release escrow funds     |
| POST   | `/escrows/:id/dispute`        | Raise a dispute          |

### Webhooks

| Method | Endpoint        | Description        |
| ------ | --------------- | ------------------ |
| POST   | `/webhooks`     | Register webhook (subscribe to: `*` for all events, or specific event types like `gig.created`, `dispute.raised`, `ipfs.pin.created`, etc.) |
| DELETE | `/webhooks/:id` | Unregister webhook |

### Monitoring

| Method | Endpoint   | Description        |
| ------ | ---------- | ------------------ |
| GET    | `/health`  | Health check       |
| GET    | `/metrics` | Prometheus metrics |

### RPC Status

Provides visibility into Stellar RPC endpoint health and failover status. Requires JWT authentication.

| Method | Endpoint      | Description                                                  |
| ------ | ------------- | ------------------------------------------------------------ |
| GET    | `/rpc-status` | Get current RPC endpoint status, health information, and failover state |

### IPFS Pinning

| Method | Endpoint             | Description                                                |
| ------ | -------------------- | ------------------------------------------------------------ |
| POST   | `/ipfs/pins`         | Pin content across multiple providers with content-hash verification |
| GET    | `/ipfs/pins`         | List all pin records                                        |
| GET    | `/ipfs/pins/:cid`    | Get a pin record by CID                                     |
| POST   | `/ipfs/pins/:cid/verify` | Re-verify durability and top up replication if degraded |
| DELETE | `/ipfs/pins/:cid`    | Unpin from every provider currently holding the content      |

### Admin Analytics

Restricted to wallet addresses listed in `ADMIN_ADDRESSES` (see [Environment Variables](#environment-variables)). All routes require a JWT (`Authorization: Bearer ...`) from an admin address and return `403 Forbidden` for anyone else.

| Method | Endpoint                  | Description                                                  |
| ------ | -------------------------- | ------------------------------------------------------------ |
| GET    | `/admin/analytics/overview`  | Full dashboard snapshot: escrows, gigs, disputes, reputation, migrations, reconciliation |
| GET    | `/admin/analytics/escrows`   | Escrow totals and status breakdown                          |
| GET    | `/admin/analytics/gigs`      | Gig solicitation totals and status breakdown                |
| GET    | `/admin/analytics/disputes`  | Dispute saga totals, step, and verdict breakdown             |

---

## 💡 Common Use Cases

### 1. Create an Escrow

```bash
curl -X POST http://localhost:3001/escrows \
  -H "Content-Type: application/json" \
  -d '{
    "depositor": "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "beneficiary": "GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY",
    "amountXLM": "100"
  }'
```

**Response**:

```json
{
  "id": "esc-1234567890",
  "depositor": "GXXXXX...",
  "beneficiary": "GYYYY...",
  "amountXLM": "100",
  "status": "pending",
  "createdAt": "2026-06-13T00:00:00.000Z"
}
```

### 2. Raise a Dispute

```bash
curl -X POST http://localhost:3001/escrows/esc-1234567890/dispute \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Work not delivered as specified"
  }'
```

**Response**:

```json
{
  "id": "esc-1234567890",
  "status": "disputed",
  "disputeReason": "Work not delivered as specified",
  "disputedAt": "2026-06-13T01:00:00.000Z"
}
```

**Note**: This also triggers:

- Webhook event (`dispute.raised`)
- Discord notification (if configured)

### 3. Register a Webhook

```bash
curl -X POST http://localhost:3001/webhooks \
  -H "Content-Type: application/json" \
  -d '{
    "id": "my-webhook",
    "url": "https://example.com/webhooks/trustflow"
  }'
```

**Response**:

```json
{
  "registered": true,
  "id": "my-webhook"
}
```

### 4. Pin a Deliverable to IPFS

```bash
curl -X POST http://localhost:3001/ipfs/pins \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "content": "SGVsbG8sIFRydXN0RmxvdyE=",
    "filename": "milestone-1-receipt.json",
    "replicationFactor": 2
  }'
```

**Response**:

```json
{
  "cid": "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
  "size": 20,
  "filename": "milestone-1-receipt.json",
  "replicationFactor": 2,
  "status": "HEALTHY",
  "providers": [
    { "provider": "pinata", "status": "PINNED", "attempts": 1, "pinnedAt": "..." },
    { "provider": "web3.storage", "status": "PINNED", "attempts": 1, "pinnedAt": "..." }
  ],
  "createdAt": "...",
  "updatedAt": "..."
}
```

The `cid` is derived purely from the submitted bytes (CIDv1, raw, sha2-256), so any provider that
ends up storing different bytes fails content-hash verification and is automatically failed over.
If a provider later loses the pin, `POST /ipfs/pins/:cid/verify` (also run automatically by the
background re-pin worker) detects it and restores replication via a spare provider.

---

## 📦 Webhook Events and Outbox Catalog

### Event Delivery Mechanisms

TrustFlow emits events via two independent mechanisms:

1. **Direct Webhook Dispatch**: `dispute.raised` is sent synchronously to registered webhooks immediately after the dispute is created.
2. **Transactional Outbox**: Other events are persisted atomically with their triggering action in a Redis-backed outbox, then relayed asynchronously by `OutboxRelayService` to webhooks, WebSocket gateway, and workers for at-least-once delivery with deduplication.

Events delivered via the outbox include a `dedupKey` for idempotent processing (see [Receiving Webhooks](#receiving-webhooks)).

### Complete Event Catalog

#### Gig Events (Outbox-Relayed)

| Event | Module | Trigger | Status | Transport |
|-------|--------|---------|--------|-----------|
| `gig.created` | Gig | New gig posted | ✅ Implemented | Outbox |
| `gig.accepted` | Gig | Responder accepts open gig | ✅ Implemented | Outbox |
| `gig.expired` | Gig | Auto-expiry sweep runs on open gigs past respondBy | ✅ Implemented | Outbox |
| `gig.cancelled` | Gig | Poster cancels an open gig | ✅ Implemented | Outbox |

**Gig Payload Shape**:
```typescript
{
  id: string;
  title: string;
  description: string;
  budget: string; // XLM amount
  poster: string; // Stellar address
  respondBy: string; // ISO 8601 timestamp
  status: "open" | "accepted" | "expired" | "cancelled";
  acceptedBy?: string; // Responder address (if accepted)
  acceptedAt?: string; // ISO 8601 timestamp (if accepted)
  expiredAt?: string; // ISO 8601 timestamp (if expired)
  cancelledAt?: string; // ISO 8601 timestamp (if cancelled)
  createdAt: string; // ISO 8601 timestamp
}
```

#### Escrow Events

| Event | Module | Trigger | Status | Transport |
|-------|--------|---------|--------|-----------|
| `escrow.created` | Escrow | New escrow vault created | ❌ Documented but not yet emitted | Direct webhook |
| `escrow.released` | Escrow | Funds released to beneficiary | ❌ Documented but not yet emitted | Direct webhook |
| `dispute.raised` | Dispute | Dispute escalated by depositor or beneficiary | ✅ Implemented | Direct webhook |

**Escrow Payload Shape**:
```typescript
{
  id: string;
  depositor: string; // Stellar address
  beneficiary: string; // Stellar address
  amountXLM: string; // Amount in XLM
  status: "pending" | "released" | "disputed";
  milestone?: {
    id: string;
    description: string;
    amountXLM: string;
    releasedAt?: string;
  };
  createdAt: string; // ISO 8601 timestamp
  releasedAt?: string; // ISO 8601 timestamp (if released)
}
```

#### Dispute Saga Events (Outbox-Relayed)

| Event | Module | Trigger | Status | Transport |
|-------|--------|---------|--------|-----------|
| `dispute.escalated` | Dispute Saga | Dispute escalation initiated | ✅ Implemented | Outbox |
| `dispute.jurors_assigned` | Dispute Saga | Jurors randomly selected from reputation pool | ✅ Implemented | Outbox |
| `dispute.vote_cast` | Dispute Saga | A juror casts their vote | ✅ Implemented | Outbox |
| `dispute.verdict_reached` | Dispute Saga | Quorum reached and verdict determined | ✅ Implemented | Outbox |
| `dispute.payout_executed` | Dispute Saga | Funds distributed per verdict | ✅ Implemented | Outbox |
| `dispute.saga_completed` | Dispute Saga | Dispute resolved and saga marked complete | ✅ Implemented | Outbox |
| `dispute.saga_compensating` | Dispute Saga | Compensation transaction initiated on failure | ✅ Implemented | Outbox |
| `dispute.saga_failed` | Dispute Saga | Saga failed at a step and marked as failed | ✅ Implemented | Outbox |

**Dispute Saga Payload Shape**:
```typescript
{
  sagaId: string;
  escrowId: string;
  step: string; // Current saga step
  status: "pending" | "completed" | "failed" | "compensating";
  jurors?: string[]; // Array of juror Stellar addresses
  votes?: {
    juror: string;
    decision: "for_depositor" | "for_beneficiary";
  }[];
  verdict?: "for_depositor" | "for_beneficiary";
  verdictAt?: string; // ISO 8601 timestamp
  payoutDetails?: {
    recipient: string; // Stellar address
    amountXLM: string;
  };
  error?: string; // Error message on failure
  createdAt: string; // ISO 8601 timestamp
}
```

#### IPFS Pinning Events (Outbox-Relayed)

| Event | Module | Trigger | Status | Transport |
|-------|--------|---------|--------|-----------|
| `ipfs.pin.created` | IPFS Pinning | Content pinned to at least one provider | ✅ Implemented | Outbox |
| `ipfs.pin.degraded` | IPFS Pinning | Pin dropped below target replication factor | ✅ Implemented | Outbox |
| `ipfs.pin.restored` | IPFS Pinning | Replication restored to target level | ✅ Implemented | Outbox |
| `ipfs.pin.lost` | IPFS Pinning | A provider dropped a previously-pinned CID | ✅ Implemented | Outbox |
| `ipfs.pin.failed` | IPFS Pinning | All providers failed to pin a CID | ✅ Implemented | Outbox |
| `ipfs.pin.removed` | IPFS Pinning | Content unpinned from all providers | ✅ Implemented | Outbox |

**IPFS Pinning Payload Shape**:
```typescript
{
  cid: string; // Content identifier (CIDv1, base32-encoded)
  size: number; // Content size in bytes
  filename?: string; // Optional original filename
  replicationFactor: number; // Target replica count
  status: "PINNING" | "HEALTHY" | "DEGRADED" | "FAILED";
  providers: {
    provider: "pinata" | "web3.storage" | "infura";
    status: "PINNED" | "FAILED" | "LOST";
    attempts: number;
    pinnedAt?: string; // ISO 8601 timestamp
  }[];
  createdAt: string; // ISO 8601 timestamp
  updatedAt: string; // ISO 8601 timestamp
}
```

#### Escrow Reconciliation Events (Outbox-Relayed)

| Event | Module | Trigger | Status | Transport |
|-------|--------|---------|--------|-----------|
| `escrow_reconciliation.drift_detected` | Escrow Reconciliation | Off-chain state diverges from on-chain | ✅ Implemented | Outbox |
| `escrow_reconciliation.escrow_backfilled` | Escrow Reconciliation | Missing on-chain escrow backfilled from on-chain | ✅ Implemented | Outbox |

**Escrow Reconciliation Payload Shape**:
```typescript
{
  escrowId: string;
  driftType: "state_mismatch" | "missing_escrow";
  onChainAmount?: string;
  offChainAmount?: string;
  detailedAt: string; // ISO 8601 timestamp
}
```

### Webhook Payload Envelope

All webhook POST requests to registered endpoints follow this envelope format:

```json
{
  "event": "gig.created",
  "data": {
    "id": "gig-123",
    "title": "Fix my website",
    "description": "Update contact form",
    "budget": "50",
    "poster": "GXXXXX...",
    "respondBy": "2026-06-20T00:00:00.000Z",
    "status": "open",
    "createdAt": "2026-06-13T00:00:00.000Z"
  },
  "timestamp": "2026-06-13T00:00:00.000Z",
  "dedupKey": "gig:gig-123:gig.created"
}
```

- `event`: The event type name (from the catalog above).
- `data`: Event-specific payload (shape depends on event type).
- `timestamp`: ISO 8601 UTC timestamp when the event was created.
- `dedupKey`: Stable deduplication key (for outbox-relayed events). Use this to detect and drop duplicates from at-least-once delivery.

### Receiving Webhooks

#### Signature Verification

If a `secret` was provided when registering the webhook, the API includes an `X-TrustFlow-Signature` header on every POST request. The signature is a hex-encoded HMAC-SHA256 of the **raw JSON request body** using the registered secret.

**Node.js Example**:

```typescript
import * as crypto from 'crypto';

const secret = 'your-registered-secret';
const rawBody = JSON.stringify(payload); // Use the raw request body
const signature = crypto
  .createHmac('sha256', secret)
  .update(rawBody, 'utf8')
  .digest('hex');

// Compare with header
const headerSignature = req.headers['x-trustflow-signature'];
if (signature !== headerSignature) {
  console.error('Signature verification failed');
  res.statusCode = 401;
  res.end();
  return;
}
console.log('Signature verified');
```

**Important**: Always verify signatures before processing the webhook payload to ensure authenticity.

#### Idempotent Processing

Events delivered via the outbox include a `dedupKey` field. Persist this key in your system and skip processing if a duplicate arrives (at-least-once delivery guarantee).

**Node.js Example**:

```typescript
// Pseudo-code; replace with your database logic
const existingEvent = await db.webhookEvents.findOne({ dedupKey: payload.dedupKey });
if (existingEvent) {
  console.log('Duplicate detected; skipping');
  res.statusCode = 200;
  res.end();
  return;
}

// Process the event
await processEvent(payload);

// Persist the dedupKey to prevent reprocessing
await db.webhookEvents.insert({ dedupKey: payload.dedupKey, ...payload });
```

#### Retry and Timeout Behavior

- **Timeout**: HTTP requests to your endpoint time out after 10 seconds (`WEBHOOK_TIMEOUT_MS`).
- **Retries**: Failed deliveries are retried up to 3 times. Only network errors (socket timeouts, DNS failures, connection resets) and HTTP 5xx responses trigger a retry; 4xx responses and other errors do not retry.
- **Backoff**: Retry delay starts at 1 second and increases linearly (1s, 2s, 3s). Maximum delay is capped at 30 seconds.
- **Delivery Guarantee**: At-least-once — your endpoint may receive the same event multiple times on failure or crash recovery. Always use `dedupKey` for idempotency.

**Retry Logic**:
- Attempt 1: Immediate
- Attempt 2: ~1s delay
- Attempt 3: ~2s delay  
- Attempt 4: ~3s delay
- If all fail, the event is retried periodically by the outbox relay with exponential backoff (capped at 30s).

### Registering a Webhook

```bash
curl -X POST http://localhost:3001/webhooks \
  -H "Content-Type: application/json" \
  -d '{
    "id": "my-webhook-1",
    "url": "https://example.com/webhooks/trustflow",
    "events": ["gig.created", "dispute.raised"],
    "secret": "your-16-char-minimum-secret"
  }'
```

**Response**:

```json
{
  "registered": true,
  "id": "my-webhook-1"
}
```

- `id`: Unique identifier for this webhook (used to unregister).
- `url`: HTTPS-accessible endpoint (HTTP allowed in development; SSRF-protected in production).
- `events`: Optional array of event types to subscribe to. If omitted or `["*"]`, all events are sent.
- `secret`: Optional 16+ character secret for signature verification. If omitted, no signature header is sent.

---

## 🔧 Response Codes

| Code | Description                           |
| ---- | ------------------------------------- |
| 200  | Success                               |
| 201  | Created                               |
| 400  | Bad Request - Invalid input           |
| 401  | Unauthorized - Invalid or missing JWT |
| 404  | Not Found - Resource doesn't exist    |
| 500  | Internal Server Error                 |
| 503  | Service Unavailable                   |

---

## 🛠️ Development

### Running the Server

```bash
cd backend
npm install
npm run dev
```

The API will be available at: `http://localhost:3001`  
Swagger UI will be at: `http://localhost:3001/api/docs`

### Environment Variables

```env
PORT=3001
JWT_SECRET=your-secret
REDIS_URL=redis://localhost:6379
RATE_LIMIT_ABUSE_WINDOW_SECONDS=300
RATE_LIMIT_ABUSE_THRESHOLD=5
RATE_LIMIT_LOCKOUT_SECONDS=900
IDEMPOTENCY_KEY_TTL_SECONDS=86400
STELLAR_NETWORK=TESTNET
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
# Multiple endpoints for RPC failover (comma-separated, first is primary)
STELLAR_HORIZON_ENDPOINTS=https://horizon-testnet.stellar.org,https://testnet.stellar.org
SOROBAN_RPC_ENDPOINTS=https://soroban-testnet.stellar.org,https://rpc-testnet.stellar.org
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/... (optional)

# IPFS pinning providers (all optional — unconfigured providers run in an
# in-memory simulated mode so pinning/failover work out of the box in dev/CI)
PINATA_JWT=
WEB3_STORAGE_TOKEN=
INFURA_IPFS_PROJECT_ID=
INFURA_IPFS_PROJECT_SECRET=
IPFS_REPIN_INTERVAL_MS=300000

# Admin dashboard — comma-separated Stellar addresses allowed to call /admin/*
# (required for those routes to return anything but 403)
ADMIN_ADDRESSES=
```

---

## 📚 OpenAPI Specification

### Exporting OpenAPI JSON

```bash
# Get the specification
curl http://localhost:3001/api/docs-json > openapi.json
```

### Using with Other Tools

The OpenAPI specification can be used with:

- **Postman**: Import the JSON to create a collection
- **Insomnia**: Import for API testing
- **Code Generators**: Generate client SDKs
  ```bash
  # Generate TypeScript client
  npx @openapitools/openapi-generator-cli generate \
    -i http://localhost:3001/api/docs-json \
    -g typescript-axios \
    -o ./generated-client
  ```

---

## 🧪 Testing with Swagger UI

1. **Start the server**: `npm run dev`
2. **Open Swagger UI**: http://localhost:3001/api/docs
3. **Try an endpoint**:
   - Click on any endpoint (e.g., `GET /health`)
   - Click "Try it out"
   - Fill in parameters (if any)
   - Click "Execute"
   - View the response

### Testing Authentication Flow

1. **Get Challenge**:
   - Expand `GET /auth/challenge`
   - Enter your Stellar address
   - Execute
   - Copy the challenge message

2. **Sign with your wallet** (outside Swagger)

3. **Verify Signature**:
   - Expand `POST /auth/verify`
   - Enter address and signature
   - Execute
   - Copy the JWT token

4. **Authorize**:
   - Click 🔒 "Authorize" button at top
   - Paste your JWT token
   - Click "Authorize"

5. **Test Protected Endpoints**: Now you can test escrow endpoints!

---

## 🎨 Customization

### Adding New Endpoints

When adding new endpoints, include Swagger decorators:

```typescript
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

@ApiTags('YourTag')
@Controller('your-route')
export class YourController {
  @Get()
  @ApiOperation({ summary: 'Your endpoint summary' })
  @ApiResponse({ status: 200, description: 'Success response' })
  yourMethod() {
    // ...
  }
}
```

### Available Decorators

- `@ApiTags()` - Group endpoints by tag
- `@ApiOperation()` - Describe the endpoint
- `@ApiResponse()` - Document response schemas
- `@ApiParam()` - Document path parameters
- `@ApiQuery()` - Document query parameters
- `@ApiBody()` - Document request body
- `@ApiBearerAuth()` - Mark as requiring JWT

---

## 📖 Additional Resources

- [NestJS Swagger Documentation](https://docs.nestjs.com/openapi/introduction)
- [OpenAPI Specification](https://swagger.io/specification/)
- [Swagger UI Documentation](https://swagger.io/tools/swagger-ui/)

---

## 🤝 Contributing

When adding new API endpoints:

1. ✅ Add Swagger decorators to controllers
2. ✅ Document all parameters and responses
3. ✅ Test in Swagger UI
4. ✅ Update this documentation if needed

---

## 📞 Support

- **Documentation**: http://localhost:3001/api/docs
- **Issues**: https://github.com/trustflow-protocol/trustflow-backend/issues
- **Community**: Discord (link in main README)

---

_Auto-generated API documentation powered by Swagger/OpenAPI_
