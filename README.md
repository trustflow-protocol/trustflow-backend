# 🔧 TrustFlow Core — Backend API

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **The off-chain backbone of the TrustFlow Protocol.**

TrustFlow Core is the backend API service that powers off-chain logic for the TrustFlow gig-economy platform. Built with NestJS and TypeScript, it bridges the Stellar/Soroban blockchain with real-world application features — handling authentication, escrow state management, webhook delivery, and Prometheus-grade observability.

---

## ✨ Core Features

- 🔐 **JWT Authentication with Wallet Signatures**: Secure wallet-based auth using Stellar signature verification. Users authenticate by signing a cryptographic challenge with their Freighter wallet, proving ownership without exposing private keys.
- 💼 **Escrow Management**: Full CRUD API for escrow entities — creation, funding, milestone tracking.
- 🌐 **Stellar Integration**: Native Horizon and Soroban RPC helpers for on-chain reads and writes.
- 🔔 **Webhook Engine**: Event-driven webhook dispatch with automatic retry logic.
- 📊 **Monitoring & Metrics**: Built-in Prometheus metrics, health checks, and alerting helpers.

---

## 🗂️ Project Structure

```
backend/
├── src/
│   ├── auth/               # JWT auth — controller, guard, service, strategy, DTOs
│   │   ├── dto/            # Request/response DTOs for validation
│   │   └── auth.module.ts # Auth module configuration
│   ├── escrow/             # Escrow API — controller, service, DTOs, entity
│   ├── stellar/            # Stellar helpers — Horizon, Soroban, config, service
│   ├── webhook/            # Webhook dispatch — controller, service, retry helper
│   ├── monitoring/         # Health checks, metrics, Prometheus helpers
│   └── main.ts             # App entry point
```

---

## 🚀 Getting Started

### Prerequisites

- Node.js >= 20
- A Stellar RPC endpoint (testnet or mainnet)
- Freighter wallet (for client-side wallet signature testing)

### Installation

```bash
npm install
```

### Environment Setup

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

Key variables:

```env
JWT_SECRET=your-secret
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
HORIZON_URL=https://horizon-testnet.stellar.org
```

### Running

```bash
# Development
cd backend
npm run dev

# Production
npm run build && npm start

# Run tests
npm test

# Run CI checks locally
./scripts/ci-check.sh
```

See [Backend Setup Instructions](backend/SETUP_INSTRUCTIONS.md) for detailed development workflow.

---

## 📖 API Modules

### 📚 Interactive API Documentation

**Swagger UI**: `http://localhost:3001/api/docs`  
**OpenAPI JSON**: `http://localhost:3001/api/docs-json`

Full guide: [API Documentation](backend/API_DOCUMENTATION.md)

### Auth (`/auth`)

- **`GET /auth/challenge`** — Get authentication challenge for wallet signing
- **`POST /auth/verify`** — Verify wallet signature, returns JWT
- JWT Guard protects all downstream routes.

#### Authentication Flow

1. **Request Challenge**: Client requests a cryptographic challenge for their wallet address
2. **Sign Challenge**: User signs the challenge with their Freighter wallet
3. **Verify & Get Token**: Client sends the signature to verify and receive a JWT token
4. **Use Token**: Include JWT in Authorization header for authenticated requests

#### Example Usage

```bash
# 1. Get challenge
curl "http://localhost:3001/auth/challenge?address=GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"

# 2. Sign challenge with Freighter wallet (client-side)

# 3. Verify signature and get JWT
curl -X POST http://localhost:3001/auth/verify \
  -H "Content-Type: application/json" \
  -d '{"address":"G...","signature":"..."}'

# 4. Use JWT for authenticated requests
curl http://localhost:3001/escrows \
  -H "Authorization: Bearer <jwt-token>"
```

### Escrow (`/escrow`)

- **`POST /escrow`** — Create a new escrow vault.
- **`GET /escrow/:id`** — Fetch escrow state and milestone details.
- **`GET /escrow/depositor/:address`** — Get all escrows by depositor
- **`POST /escrow/:id/release`** — Approve a milestone tranche.
- **`POST /escrow/:id/dispute`** — Raise a dispute (triggers Discord notification).

### Webhooks (`/webhook`)

- **`POST /webhook`** — Register a webhook endpoint.
- **`DELETE /webhook/:id`** — Unregister a webhook.
- Automatic retry logic handles delivery failures gracefully.
- **Discord Integration**: Automatically notifies a Discord channel when disputes need jurors. [Setup Guide](backend/src/webhook/DISCORD_INTEGRATION.md)

### Monitoring (`/health`, `/metrics`)

- **`GET /health`** — Liveness and readiness probe.
- **`GET /metrics`** — Prometheus-compatible metrics endpoint.

---

## 🛡️ Security

- **Wallet Signature Verification**: Uses @stellar/stellar-sdk for cryptographic signature verification
- **Challenge Expiration**: Challenges expire after 5 minutes to prevent replay attacks
- **One-Time Use**: Each challenge can only be used once
- **JWT Expiration**: Tokens expire after 24 hours
- **Address Validation**: Validates Stellar public key format (G-prefixed, 56 characters)
- **Input Validation**: Uses class-validator DTOs on all endpoints
- **Guard Middleware**: All protected routes require valid JWT via JwtAuthGuard
- **Environment Secrets**: Never logged or exposed in responses

For detailed authentication implementation documentation, see [AUTH_IMPLEMENTATION.md](backend/src/auth/AUTH_IMPLEMENTATION.md).

---

## 🔄 CI/CD

The project uses GitHub Actions for continuous integration:

- ✅ **Automated Testing**: Runs on every PR affecting backend code
- ✅ **Multi-Version Testing**: Tests against Node.js 18.x and 20.x
- ✅ **Code Quality**: ESLint and Prettier checks
- ✅ **Type Safety**: TypeScript compilation and type checking
- ✅ **Fast Builds**: Target runtime under 3 minutes
- ✅ **Branch Protection**: PRs blocked on failing tests

See [CI/CD Documentation](.github/workflows/README.md) for details.

**Local CI Check**:

```bash
cd backend && ./scripts/ci-check.sh
```

---

## 🗺️ Roadmap

- [x] **JWT Authentication with Wallet Signatures**: Implemented Stellar signature verification
- [ ] **GraphQL Layer**: Optional GraphQL gateway over REST endpoints.
- [ ] **Rate Limiting**: Per-wallet throttling on auth and escrow routes.
- [ ] **Event Sourcing**: Full audit log for all escrow state transitions.
- [ ] **Multi-network Support**: Seamless mainnet/testnet switching via config.
- [ ] **Token Refresh**: Implement refresh token mechanism for better UX
- [ ] **Redis Integration**: Use Redis for distributed challenge storage

---

## 🤝 Community & Support

- **Documentation**: [Full API Reference](https://docs.trustflow.xyz)
- **Issues**: [Report bugs or request features](https://github.com/trustflow-protocol/trustflow-core/issues)
- **Discussions**: [Stellar Community Forum](https://stellar.org/community)

---

_Securing the future of work, one transaction at a time._

---

## 📜 License

MIT License. Copyright (c) 2026 TrustFlow Protocol.
