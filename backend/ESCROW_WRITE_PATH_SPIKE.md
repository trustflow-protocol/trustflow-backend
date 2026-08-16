# Escrow On-Chain Write Path — Spike Findings

**Issue**: #180 - Spike: Define the on-chain write path for escrow actions (create/release/dispute)  
**Status**: ✅ Spike complete — recommendation + working prototype  
**Estimated Time**: 2-3 days (time-boxed spike)  
**Difficulty**: 🟣 Spike

## Overview

`EscrowService` is a purely in-memory store — `create`, `release`, and `raiseDispute` never build, sign, or submit a Soroban transaction. A **read** path from chain to API state already exists (`event-ingestion` → `EscrowService`, plus `escrow-reconciliation` diffing DB against chain), but no **write** path from the API back to chain existed at all. This document maps the current state, evaluates the two candidate write-path architectures, and recommends one, backed by a working prototype for the `release` action.

## 1. Action-by-action chain touch map

| Action | Reaches chain today? | Would `event-ingestion` observe it? |
| --- | --- | --- |
| `EscrowService.create` | No — writes only to the in-memory `Map` | Yes, via `escrow_created` → `handleEscrowCreated` |
| `EscrowController` `POST /escrows` | No — calls `EscrowService.create` directly | Same as above |
| `EscrowService.release` | No — flips `status` locally | Yes, via `escrow_released` → `handleEscrowReleased` |
| `EscrowController` `POST /escrows/:id/release` | No | Same as above |
| `EscrowService.raiseDispute` | No — flips `status`/`disputeReason` locally | Yes, via `escrow_disputed` → `handleEscrowDisputed` |
| `EscrowController` `POST /escrows/:id/dispute` | No (but does fire a webhook + Discord notification for jurors) | Same as above |
| `EscrowReconciliationService` | Reads chain via `SorobanEscrowChainStateClient`, never writes to it | N/A (it's the read side) |

Every REST write endpoint is, today, a pure DB mutation with no on-chain effect — none of the three actions has ever built a Soroban transaction. `event-processor.service.ts` already has a correctly-shaped handler for all three event types, so **the read side of the round-trip is not the gap**; only the write side is.

One existing signal was worth surfacing: `escrow.dto.ts` already defines an unused `ReleaseEscrowSchema` with a `signerAddress` field, and `auth.service.ts` already verifies client-supplied signatures (`Keypair.verify` against a challenge). Neither is wired to the escrow write endpoints. Read together, they look like an earlier, unfinished lean toward a client-signed design — consistent with the recommendation below.

## 2. Server-signed vs. client-signed: evaluation

### Option A — Server-side signing (backend holds a key, submits the transaction)

- Requires custody of a Soroban-authorized signing key in the backend's runtime (env var, KMS, or HSM).
- **No such infrastructure exists anywhere in this codebase today** — there is no secrets-manager, KMS, or HSM client in `package.json` or `src/`. This would be a new category of infrastructure, not a config addition.
- Whoever controls that key can move funds unilaterally for every escrow — a single-key custody model is a large blast-radius target, and this repo has no existing key-rotation, multi-sig, or rate-limiting story to bound the risk.
- Does not remove the round-trip through `event-ingestion`: `EscrowService` is only ever mutated via events today (see the table above — even `applyChainState`/`createFromChainState` exist specifically so the reconciler drives DB state from chain, not the other way). So server custody wouldn't even shortcut a state update; the DB would still wait for the same event that a client-signed submission would also produce.

### Option B — Client-signed (backend builds/simulates unsigned XDR; the caller's wallet signs and submits)

- No custody anywhere in the backend. The worst a compromised backend can do is build a transaction *that still requires an external signature*.
- Matches the existing read-side architecture: chain is the source of truth, `EscrowService` reflects it via events, and `escrow-reconciliation` already treats any DB/chain disagreement as drift to repair — a client-signed submission fits that model without changing it.
- Matches the sibling spike issues referenced in #180: the SDK's `TrustFlowEscrowClient` (currently mocked) is presumably the intended signing surface, and `signerAddress` in `escrow.dto.ts` already anticipates a caller-identified signer.
- Cost: the backend can't unilaterally guarantee a release happens (e.g., it can't auto-release on a timer without a delegated key). If that capability is ever required, it can be added later as an explicit, scoped exception (e.g., a dedicated timeout-only key with a single restricted entrypoint) rather than as the default for every action.

### Recommendation

**Client-signed.** The backend acts purely as a transaction *builder* (and simulator, to catch obviously-invalid calls before the client bothers signing). It never holds a key that can move escrowed funds. This is the lower-blast-radius option, requires no new custody infrastructure, and is consistent with the read-path architecture already built in this repo.

## 3. Prototype: unsigned `release` transaction builder

Added `EscrowReleaseTransactionBuilderService` (`src/escrow-write/escrow-release-transaction-builder.service.ts`) and wired it into `EscrowController` as:

```
GET /escrows/:id/release/transaction?sourceAccount=G...
```

Flow:

1. Look up the escrow, confirm it's linked to an on-chain ID (`escrow.contractEscrowId`) — same linkage `escrow-reconciliation` already relies on.
2. Load the given `sourceAccount` from Soroban RPC and build a `Contract.call('release', contractEscrowId)` invocation, using `STELLAR_CONFIG` (the same config object `StellarService` and `SorobanEscrowChainStateClient` already read from).
3. `rpc.Server.prepareTransaction()` — this both simulates the call and assembles the correct footprint/auth entries.
4. Return the unsigned XDR to the caller. **The backend never signs or submits it.** The caller's wallet (or `trustflow-sdk`) does that directly against Soroban RPC; the resulting `escrow_released` event flows back through the existing, unmodified `event-ingestion` pipeline.

This demonstrates the mechanics of one escrow action's write path reaching the chain boundary end-to-end (account load → contract invocation → simulation/footprint assembly → XDR), which was the concrete unknown this spike needed to resolve.

The RPC server and Stellar config are injected via Nest provider tokens (`SOROBAN_RPC_SERVER`, `ESCROW_WRITE_STELLAR_CONFIG` in `escrow-write.module.ts`) rather than constructed inline, so tests supply a mocked RPC server and an arbitrary config object directly — no `jest.resetModules()`/`process.env` mutation needed. `sourceAccount` validation lives in `BuildReleaseTransactionQueryDto` (`class-validator`, reusing the shared `STELLAR_ADDRESS_REGEX` from `escrow.dto.ts`) and runs through the app's existing global `ValidationPipe`, verified with a Supertest-driven integration test (`escrow.controller.spec.ts`) that boots a real Nest app, matching the pattern already used in `reputation.controller.spec.ts`.

Tests (`escrow-release-transaction-builder.service.spec.ts`, `escrow.controller.spec.ts`) exercise this with mocked RPC responses — no live network access, so CI stays fully offline-safe. See §5 for why this stops short of a live testnet run.

## 4. Reconciliation with `stellar.service.ts` / `soroban.helper.ts`

- `StellarService` only wraps read-only Horizon calls (`getBalance`, `getLatestLedger`, `isAddressActive`) — nothing in it conflicts with or needs to change for a write path.
- `soroban.helper.ts`'s `simulateTransaction` is a pre-existing, unused, and self-contained stub (hardcodes `Networks.TESTNET` rather than reading `STELLAR_CONFIG`). It doesn't yet do what this prototype needs, so `EscrowReleaseTransactionBuilderService` calls `rpc.Server.prepareTransaction()` directly instead of reusing it. Left as-is, out of scope for this spike.
- `EscrowChainStateClient` / `SorobanEscrowChainStateClient` remain the read side; this prototype adds the mirror-image write side under `src/escrow-write/`, deliberately kept as a separate module (same reasoning `EscrowChainStateClient`'s own docstring gives for its own separation: independent concerns, independent evolution).

## 5. Blocking unknowns

- **Contract entrypoint shape is unverified.** No contract source lives in this repo. The `release(escrow_id)` entrypoint name and single-argument shape used here are an assumption, mirroring the same documented assumption `SorobanEscrowChainStateClient` already makes about the storage-key layout. The issue itself flags the contract repo's non-disputed release entrypoint as not yet built. Once it lands, only `EscrowReleaseTransactionBuilderService.buildRelease`'s `contract.call(...)` needs to change.
- **No live testnet verification.** This environment has no funded testnet keypair and no confirmed deployed `TRUSTFLOW_CONTRACT_ID`, so the prototype is verified against mocked RPC responses only, not a real submission. Recommend the follow-up implementation issue includes running this against a real deployed contract on testnet before merging a production version.
- **Auth requirements on `release` are unknown.** Depending on the contract, `release` may need to be authorized by the depositor, an oracle/arbiter, or the beneficiary — which changes who `sourceAccount` should be. This prototype leaves that entirely up to the caller (any Stellar address may be passed as `sourceAccount`); the contract's `require_auth` (once it exists) is the real gate, not this endpoint.
- **`create` and `raiseDispute` are not prototyped.** `release` was chosen as the one end-to-end action per the issue's acceptance criteria. The same builder pattern generalizes directly to `create`/`dispute` once their entrypoints are confirmed — tracked in the follow-up issues below.

## 6. Follow-up issues filed

- Wire client-signed `create`/`dispute` transaction builders using the same pattern as `EscrowReleaseTransactionBuilderService`, once entrypoint names are confirmed against the deployed contract.
- Verify `EscrowReleaseTransactionBuilderService` against a real deployed testnet contract (funded keypair + confirmed `TRUSTFLOW_CONTRACT_ID`), and wire `trustflow-sdk`'s `TrustFlowEscrowClient` to call these endpoints and submit the signed result.

(Filed as GitHub issues linked from #180.)
