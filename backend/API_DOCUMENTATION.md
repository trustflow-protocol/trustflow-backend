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
| POST   | `/webhooks`     | Register webhook   |
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

## 📦 Webhook Events

When you register a webhook, you'll receive POST requests for these events:

### Event Types

| Event              | Description        | Payload            |
| ------------------ | ------------------ | ------------------ |
| `escrow.created`   | New escrow created | Escrow details     |
| `escrow.released`  | Funds released     | Escrow details     |
| `dispute.raised`   | Dispute initiated  | Dispute details    |
| `dispute.resolved` | Dispute resolved   | Resolution details |
| `ipfs.pin.created`  | Content newly pinned                          | CID, replication factor, pinned providers |
| `ipfs.pin.degraded` | Pin dropped below its replication factor      | CID                                        |
| `ipfs.pin.restored` | Replication restored after a loss             | CID, healthy provider count                |
| `ipfs.pin.lost`      | A provider no longer holds a previously-pinned CID | CID, provider                        |
| `ipfs.pin.failed`   | Every registered provider failed to pin a CID | CID                                        |
| `ipfs.pin.removed`  | Content unpinned from all providers           | CID                                        |

### Webhook Payload Format

```json
{
  "event": "dispute.raised",
  "data": {
    "escrowId": "esc-1234567890",
    "depositor": "GXXXXX...",
    "beneficiary": "GYYYY...",
    "amountXLM": "100",
    "reason": "Work not delivered",
    "disputedAt": "2026-06-13T01:00:00.000Z"
  },
  "timestamp": "2026-06-13T01:00:00.000Z"
}
```

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
