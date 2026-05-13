# 🔧 TrustFlow Core — Backend API

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **The off-chain backbone of the TrustFlow Protocol.**

TrustFlow Core is the backend API service that powers off-chain logic for the TrustFlow gig-economy platform. Built with NestJS and TypeScript, it bridges the Stellar/Soroban blockchain with real-world application features — handling authentication, escrow state management, webhook delivery, and Prometheus-grade observability.

---

## ✨ Core Features

- 🔐 **JWT Authentication**: Secure wallet-based auth with guard middleware and JWT strategy.
- 💼 **Escrow Management**: Full CRUD API for escrow entities — creation, funding, milestone tracking.
- 🌐 **Stellar Integration**: Native Horizon and Soroban RPC helpers for on-chain reads and writes.
- 🔔 **Webhook Engine**: Event-driven webhook dispatch with automatic retry logic.
- 📊 **Monitoring & Metrics**: Built-in Prometheus metrics, health checks, and alerting helpers.

---

## 🗂️ Project Structure

```
backend/
├── src/
│   ├── auth/               # JWT auth — controller, guard, service, strategy
│   ├── escrow/             # Escrow API — controller, service, DTOs, entity
│   ├── stellar/            # Stellar helpers — Horizon, Soroban, config, service
│   ├── webhook/            # Webhook dispatch — controller, service, retry helper
│   ├── monitoring/         # Health checks, metrics, Prometheus helpers
│   └── index.js            # App entry point
```

---

## 🚀 Getting Started

### Prerequisites
- Node.js >= 18
- A Stellar RPC endpoint (testnet or mainnet)

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
npm run dev

# Production
npm run build && npm start
```

---

## 📖 API Modules

### Auth (`/auth`)
- **`POST /auth/login`** — Wallet-signed authentication, returns JWT.
- JWT Guard protects all downstream routes.

### Escrow (`/escrow`)
- **`POST /escrow`** — Create a new escrow vault.
- **`GET /escrow/:id`** — Fetch escrow state and milestone details.
- **`PATCH /escrow/:id/release`** — Approve a milestone tranche.

### Webhooks (`/webhook`)
- **`POST /webhook`** — Register a webhook endpoint.
- Automatic retry logic handles delivery failures gracefully.

### Monitoring (`/health`, `/metrics`)
- **`GET /health`** — Liveness and readiness probe.
- **`GET /metrics`** — Prometheus-compatible metrics endpoint.

---

## 🛡️ Security

- All routes behind the `AuthGuard` require a valid JWT.
- Input validation via class-validator DTOs on all write endpoints.
- Environment secrets never logged or exposed in responses.

---

## 🗺️ Roadmap

- [ ] **GraphQL Layer**: Optional GraphQL gateway over REST endpoints.
- [ ] **Rate Limiting**: Per-wallet throttling on auth and escrow routes.
- [ ] **Event Sourcing**: Full audit log for all escrow state transitions.
- [ ] **Multi-network Support**: Seamless mainnet/testnet switching via config.

---

## 🤝 Community & Support

- **Documentation**: [Full API Reference](https://docs.trustflow.xyz)
- **Issues**: [Report bugs or request features](https://github.com/trustflow-protocol/trustflow-core/issues)
- **Discussions**: [Stellar Community Forum](https://stellar.org/community)

---

*Securing the future of work, one transaction at a time.*

---

## 📜 License

MIT License. Copyright (c) 2026 TrustFlow Protocol.
