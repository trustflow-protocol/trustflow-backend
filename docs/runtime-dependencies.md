# Runtime Dependencies

This document describes each external dependency the TrustFlow backend can use, what behavior changes when each is configured or unavailable, and which are required for production deployments.

## Summary Table

| Dependency | Required for Production | Behavior When Unset | Behavior When Down |
|---|---|---|---|
| **Redis** | Yes | Per-instance state divergence | Rate limiting and caching degrade; some services fail |
| **PostgreSQL** | No (currently) | Not configured | Domain services log warnings |
| **Stellar Horizon RPC** | Yes (for on-chain reads) | Soroban events won't sync | Event ingestion stalls; status unhealthy |
| **Soroban RPC** | Yes (for on-chain operations) | On-chain operations fail at API boundary | Event ingestion stalls; status unhealthy |
| **JWT_SECRET** | Yes | Validation fails at startup | App won't start |
| **ADMIN_ADDRESSES** | No (defaults to deny-all) | Every admin route returns 403 | Admin routes return 403 |
| **DISCORD_WEBHOOK_URL** | No | Dispute notifications not sent | Dispute notifications silently dropped |
| **IPFS Providers** | No | Simulated in-memory pinning | No external pins; local tracking only |
| **Sentry DSN** | No | Errors logged locally only | Errors logged locally only |

---

## Detailed Dependency Profiles

### Redis

**Environment Variables:**
- `REDIS_URL` (connection string, e.g., `redis://localhost:6379`)

**What Uses It:**
- `RateLimitGuard` — per-IP and per-wallet request throttling
- `NonceStoreService` — challenge/response anti-replay store
- `IdempotencyKeyService` — deduplication for concurrent requests
- `DistributedLockService` — coordinating sweep workers across instances
- `GigService` — gig posting and acceptance store
- `OutboxService` — event relay queue
- `DeliverableService` — deliverable submission tracking
- `SorobanEventIndexerService` — processed-event cursor
- `EscrowService` — escrow state (in production only)

**Behavior When Unset:**
- **RateLimitGuard**: Allows every request; logs a warning per request; no abuse protection
- **NonceStoreService**: Falls back to per-process in-memory maps; a challenge issued by one backend instance cannot be verified by another (security issue in clustered deployments)
- **IdempotencyKeyService**: Every request is considered unique; no deduplication
- **DistributedLockService**: Every instance believes it holds the lock; sweep workers run concurrently on all nodes (resource waste, potential duplication)
- **GigService**: Falls back to in-memory maps; gig state is lost on restart and not shared across instances
- **OutboxService**: Falls back to in-memory queue in non-production; throws startup error in production
- **EscrowService**: Falls back to in-memory maps in non-production; throws startup error in production (money-adjacent state must not diverge per-instance)
- **Other services**: Use in-memory fallbacks where Redis is absent

**Behavior When Down (Connection Error):**
- **RateLimitGuard**: Redis errors surface as HTTP 500 responses
- **Most services**: Operations fail or return 500; some log errors and continue with degraded behavior
- **Health check** (`GET /health`): Redis health status reported as unhealthy

**Production Requirement:**
- **REQUIRED**. Redis is mandatory for rate limiting, coordinating distributed sweeps, and ensuring escrow state consistency across instances. A single-instance deployment still requires Redis; without it, there is no anti-abuse protection and escrow state is not durable.

---

### PostgreSQL

**Environment Variables:**
- `DATABASE_URL` (connection string, e.g., `postgresql://user:pass@localhost:5432/trustflow`), OR
- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` (individual fields)
- `DB_SSL`, `DB_SSL_CA`, `DB_SSL_CERT`, `DB_SSL_KEY`, `DB_SSL_REJECT_UNAUTHORIZED` (SSL options)
- `DB_POOL_MAX`, `DB_POOL_IDLE_TIMEOUT_MS`, `DB_POOL_CONNECTION_TIMEOUT_MS` (pool tuning)

**What Uses It:**
- Currently **not used by domain services**. The `DatabaseService` is initialized but domain code does not read from it.

**Behavior When Unset:**
- `DatabaseService` reports "not configured"
- `HealthService.checkDatabase()` reports healthy (because there is no database to check)
- No impact on running application

**Behavior When Down:**
- No impact (database is not currently used)

**Production Requirement:**
- **OPTIONAL** (not yet used). This is infrastructure for future domain service adoption. See `PERSISTENT_STORAGE_SPIKE.md` for the decision to defer relational storage to a later phase.

---

### Stellar Horizon RPC

**Environment Variables:**
- `STELLAR_HORIZON_URL` (defaults to `https://horizon-testnet.stellar.org`)
- `STELLAR_HORIZON_ENDPOINTS` (comma-separated failover URLs, optional)

**What Uses It:**
- `StellarService` — fetching account info, transaction status, and chain-verified state
- Event ingestion — reading historical ledger events (via Soroban RPC fallback when available)

**Behavior When Unset:**
- Defaults to testnet public endpoint; no credential-based failover
- Requests fall through to the default URL

**Behavior When Down:**
- Event ingestion stalls (cannot fetch ledger state or confirm transaction finality)
- Status endpoint shows Stellar health as unhealthy
- Client operations that depend on chain state fail with clear errors

**Production Requirement:**
- **REQUIRED** for on-chain operations. A deployed contract must be able to read state from Stellar; without it, escrow state cannot be verified or updated.

---

### Soroban RPC

**Environment Variables:**
- `SOROBAN_RPC_URL` (defaults to `https://soroban-testnet.stellar.org`)
- `SOROBAN_RPC_ENDPOINTS` (comma-separated failover URLs, optional)
- `SOROBAN_START_LEDGER` (contract deployment ledger; optional, defaults to current)
- `TRUSTFLOW_CONTRACT_ID` (contract address; required for on-chain operations)

**What Uses It:**
- `SorobanEventIndexerService` — polling for contract events
- `EventIngestionService` — fetching events from specific ledgers and handling reorgs
- `EscrowReconciliationService` — reading escrow state directly from the contract
- Escrow release transaction building — simulating contract calls to verify they will succeed

**Behavior When Unset:**
- `SOROBAN_RPC_URL` defaults to testnet; if unset and no failover is configured, falls back to default
- `TRUSTFLOW_CONTRACT_ID` is optional; operations that need it fail with a clear error
- Event ingestion does not run (no contract to poll)

**Behavior When Down:**
- Event ingestion stalls (cannot poll for new events)
- Escrow reconciliation fails (cannot read contract state)
- Escrow release and other on-chain operations fail
- Status endpoint shows Soroban health as unhealthy

**Production Requirement:**
- **REQUIRED**. Without a working Soroban RPC endpoint, the backend cannot sync with the contract or dispatch transactions.

---

### JWT_SECRET

**Environment Variables:**
- `JWT_SECRET` (required in production; optional with a test-default in development)

**What Uses It:**
- `AuthService` — signing and verifying JWT tokens for wallet-based authentication
- `JwtStrategy` — Passport middleware validating request tokens

**Behavior When Unset:**
- In `NODE_ENV=production`: Validation fails at startup; app will not boot
- In `NODE_ENV=development` or `NODE_ENV=test`: Falls back to `TEST_ONLY_JWT_SECRET` (clearly marked for testing only)

**Behavior When Down:**
- No external service; validation is cryptographic only
- Tokens signed with a changed secret are immediately invalid

**Production Requirement:**
- **REQUIRED**. The secret must be at least 16 characters, cryptographically random, and kept secure. Every deployed instance must use the same secret so tokens are valid across replicas.

---

### ADMIN_ADDRESSES

**Environment Variables:**
- `ADMIN_ADDRESSES` (comma-separated Stellar public addresses)

**What Uses It:**
- `AdminGuard` — protecting admin-only endpoints (event ingestion, escrow reconciliation, IPFS operations, migrations)
- Tested against the authenticated user's wallet address (from JWT token)

**Behavior When Unset or Empty:**
- Every admin-only route returns HTTP 403 Forbidden
- Admin actions (start event ingestion, trigger reconciliation, manage IPFS pins) are not accessible
- A warning is logged at startup

**Behavior When Down:**
- No external service; configuration is read at startup
- If an admin address is removed from the list, existing tokens remain valid but new actions are denied

**Production Requirement:**
- **RECOMMENDED**. While not strictly required (defaults to deny-all), a deployed backend should have at least one admin address to allow operational tasks. A single-instance dev setup can leave it unset for simplicity, but any production deployment needs at least one admin.

---

### DISCORD_WEBHOOK_URL

**Environment Variables:**
- `DISCORD_WEBHOOK_URL` (Discord webhook URL for notifications)

**What Uses It:**
- `DiscordService` — sending dispute notifications to a Discord channel

**Behavior When Unset:**
- Dispute notifications are not sent
- No errors; the service is a no-op

**Behavior When Down (Bad URL or Discord Outage):**
- Notification dispatch fails; error is logged but does not block the dispute operation
- A Sentry event is sent if Sentry is configured

**Production Requirement:**
- **OPTIONAL**. Useful for monitoring but not critical to backend operations. Disputes are recorded and resolved regardless of whether Discord is notified.

---

### IPFS Providers

**Environment Variables (optional; at least one recommended for production):**
- `IPFS_PINATA_JWT` — Pinata API JWT
- `IPFS_WEB3_STORAGE_TOKEN` — Web3.Storage API token
- `IPFS_INFURA_PROJECT_ID` and `IPFS_INFURA_PROJECT_SECRET` — Infura IPFS project credentials

**What Uses It:**
- `IpfsPinningService` — persisting deliverables and proof artifacts to decentralized storage
- Failover across multiple providers (tries Pinata, Web3.Storage, Infura in order)
- Simulated in-memory pinning when no credentials are provided

**Behavior When Unset:**
- Falls back to simulated (in-memory) pinning
- Pins are not persisted to IPFS; lost on restart
- `GET /ipfs/pins` returns empty list
- No errors; the service simulates success

**Behavior When Down (Network Error or API Outage):**
- Pinning operation fails
- Service tries next provider in failover chain
- If all providers fail, error is logged and returned to caller (deliverable submission fails)

**Production Requirement:**
- **RECOMMENDED**. A production deployment should configure at least one IPFS provider to ensure deliverable artifacts are persisted and retrievable. A local dev setup can use simulated pinning.

---

### Sentry DSN

**Environment Variables:**
- `SENTRY_DSN` (Sentry project DSN URL)

**What Uses It:**
- `SentryService` — capturing and reporting unhandled exceptions and errors
- Integrated via `SentryExceptionFilter` (catches all unhandled exceptions)

**Behavior When Unset:**
- Errors are logged locally via NestJS logger but not sent to Sentry
- No external error reporting
- Application continues normally

**Behavior When Down (Invalid DSN or Sentry Outage):**
- Error sending to Sentry fails silently; errors are still logged locally
- Application is not affected

**Production Requirement:**
- **RECOMMENDED** (not required). Useful for monitoring and debugging production errors. A local dev setup can skip it; a production deployment should configure it to track unexpected errors.

---

## Minimum Viable Production Setup

For a production deployment, **the following must be configured:**

1. ✅ `REDIS_URL` — working Redis instance (durability and backup are an infrastructure choice, not an application one)
2. ✅ `JWT_SECRET` — at least 16 cryptographically-random characters, kept secure
3. ✅ `ADMIN_ADDRESSES` — at least one Stellar address for operational tasks
4. ✅ `STELLAR_HORIZON_URL` and `SOROBAN_RPC_URL` — working endpoints (can use public testnet/mainnet URLs)
5. ✅ `TRUSTFLOW_CONTRACT_ID` — deployed contract address on the target network

**Recommended additions:**
- `CORS_ORIGIN` — restrict API access to known frontend origins
- `DATABASE_URL` or `DB_HOST/DB_NAME` — prepare for future domain service adoption
- `IPFS_PINATA_JWT` or `IPFS_WEB3_STORAGE_TOKEN` — persist deliverable artifacts
- `SENTRY_DSN` — track production errors
- `DISCORD_WEBHOOK_URL` — get notified of disputes

---

## Single-Node Development Setup

For local development **without external dependencies**, configure:

```bash
NODE_ENV=development
PORT=3001
JWT_SECRET=<ignored; test default used>
ADMIN_ADDRESSES=GADMIN1111111111111111111111111111111111111111111111111111111  # any testnet address
```

This gives you:
- ✅ API authentication and authorization
- ✅ Event ingestion stubs (IPFS simulated, no actual pinning)
- ✅ Admin endpoints (operational commands)
- ❌ No rate limiting (Redis not configured)
- ❌ No escrow durability (state lost on restart)
- ❌ No state sharing across instances
- ❌ No event persistence (lost on restart)

**Degradation summary:**
- Escrow state is per-process, lost on restart
- Nonce validation is per-process (replay-attack vulnerability in tests only)
- Rate limiting is disabled
- IPFS pins are simulated in-memory (no actual persistence)

This setup is suitable for **feature development and testing**, but **not production**.

---

## Checking Dependency Status at Startup

The application logs one line per dependency when starting (see `app.setup.ts`):

```
[Nest] 12345  - 09/26/2026, 10:00:00 AM   LOG [AppBootstrap] Dependencies
  redis: connected | degraded | disabled
  database: configured | not-configured
  soroban-rpc: healthy | unhealthy | default-endpoint
  horizon-rpc: healthy | unhealthy | default-endpoint
  admin: configured | warn (no admins)
  ipfs: active | simulated
```

Each line lets an operator quickly verify what is available and whether the deployment matches expectations.

---

## See Also

- `SETUP_INSTRUCTIONS.md` — step-by-step deployment guide
- `.env.example` — all environment variables with defaults and descriptions
- `PERSISTENT_STORAGE_SPIKE.md` — decision on Redis for escrows (vs. relational DB)
- `app.setup.ts` — dependency initialization and health checks
