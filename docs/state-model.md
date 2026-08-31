# Off-Chain ↔ On-Chain State Model

> **Reference for issue #245.** This document describes the current (already-implemented)
> off-chain state machines for Escrow, Gig, and DisputeSaga, what drives each transition,
> and where the off-chain model currently deviates from a clean event-sourced design.

---

## 1. Escrow

**Source**: `src/escrow/escrow.service.ts`  
**Type**: `EscrowStatus = 'pending' | 'active' | 'released' | 'disputed' | 'cancelled'`

### State Diagram

```
           API: POST /escrow
               │
               ▼
           ┌─────────┐
           │ pending │
           └────┬────┘
                │  API: POST /escrow/:id/fund
                │  OR on-chain event: escrow_funded (EventProcessorService)
                ▼
           ┌────────┐
           │ active │◄─────────────────────────────────────┐
           └───┬────┘                                       │
               │                                            │
    ┌──────────┼──────────────┐          Compensating: revert to 'active'
    │          │              │          (DisputeSagaService.compensateEscalation)
    │          │              │
    ▼          ▼              ▼
┌──────────┐ ┌──────────┐  ┌───────────┐
│ released │ │cancelled │  │ disputed  │
└──────────┘ └──────────┘  └─────┬─────┘
                                  │
              DisputeSagaService.applyPayout resolves:
              • BENEFICIARY_WINS → released
              • DEPOSITOR_WINS   → cancelled
              • SPLIT            → released (with splitPercentage)
```

### Transition Table

| From       | To         | Trigger                                                        | Source                                   |
|------------|------------|----------------------------------------------------------------|------------------------------------------|
| —          | `pending`  | `POST /escrow` (API call)                                      | `EscrowService.create()`                 |
| `pending`  | `active`   | `POST /escrow/:id/fund` (API call)                             | `EscrowService.fund()`                   |
| `pending`  | `active`   | On-chain event `escrow_funded`                                 | `EventProcessorService.handleEscrowFunded()` |
| `active`   | `released` | `POST /escrow/:id/release` (API call)                          | `EscrowService.release()`                |
| `active`   | `released` | On-chain event `escrow_released`                               | `EventProcessorService.handleEscrowReleased()` |
| `active`   | `disputed` | `POST /escrow/:id/dispute` (API call)                          | `EscrowService.raiseDispute()`           |
| `active`   | `disputed` | On-chain event `escrow_disputed`                               | `EventProcessorService.handleEscrowDisputed()` |
| `active`   | `disputed` | `DisputeSagaService.escalate()` (internal, via API)            | `EscrowService.raiseDispute()`           |
| `active`   | `cancelled`| `POST /escrow/:id/cancel` (API call)                           | `EscrowService.cancel()`                 |
| `disputed` | `released` | Saga payout — verdict BENEFICIARY_WINS or SPLIT                | `DisputeSagaService.applyPayout()`       |
| `disputed` | `cancelled`| Saga payout — verdict DEPOSITOR_WINS                           | `DisputeSagaService.applyPayout()`       |
| `disputed` | `active`   | Compensating rollback on failed escalation                     | `DisputeSagaService.compensateEscalation()` |
| any        | any        | Reconciler drift correction                                    | `EscrowService.applyChainState()`        |

### Known Deviations

- **`EventProcessorService` mutates `Escrow` directly** — `handleEscrowFunded`, `handleEscrowReleased`,
  and `handleEscrowDisputed` call `EscrowService.fund/release/raiseDispute` in exactly the same way
  as the API controllers. There is no coordination layer; if both an API call and an on-chain event
  arrive for the same escrow in a short window, one will silently overwrite the other or throw
  (depending on current status guard state).

- **`applyChainState` bypasses all guards** — the reconciler can write any status directly to any
  escrow. This is intentional for drift-repair, but it means the state machine can be put into
  states that no normal transition would produce.

- **`release()` has no precondition check** — unlike `raiseDispute()`, `EscrowService.release()`
  does not verify the current status before transitioning. An already-released or cancelled escrow
  can be re-released via API without error.

---

## 2. Gig

**Source**: `src/gig/gig.entity.ts`, `src/gig/gig.service.ts`, `src/gig/gig-expiry-worker.service.ts`  
**Type**: `GigStatus = 'open' | 'accepted' | 'expired' | 'cancelled'`

### State Diagram

```
     API: POST /gigs
          │
          ▼
      ┌──────┐
      │ open │
      └──┬───┘
         │
    ┌────┴────────────┬─────────────────────────┐
    │                 │                         │
    │ API:            │ API:                    │ Background worker:
    │ POST /gigs/:id/ │ DELETE /gigs/:id        │ GigExpiryWorkerService sweep
    │ accept          │ (cancel)                │ (every GIG_EXPIRY_SWEEP_INTERVAL_MS)
    ▼                 ▼                         ▼
┌──────────┐    ┌───────────┐           ┌─────────┐
│ accepted │    │ cancelled │           │ expired │
└──────────┘    └───────────┘           └─────────┘
```

### Transition Table

| From     | To          | Trigger                                           | Source                              |
|----------|-------------|---------------------------------------------------|-------------------------------------|
| —        | `open`      | `POST /gigs` (API call)                           | `GigService.create()`               |
| `open`   | `accepted`  | `POST /gigs/:id/accept` (API call)                | `GigService.accept()`               |
| `open`   | `cancelled` | `DELETE /gigs/:id` (API call)                     | `GigService.cancel()`               |
| `open`   | `expired`   | Background sweep past `respondBy` deadline        | `GigExpiryWorkerService` sweep      |

### Notes

- Gig status is **entirely off-chain** — there is no corresponding on-chain Soroban contract state
  for gigs in the current implementation.
- The expiry sweep runs on a configurable interval (`GIG_EXPIRY_SWEEP_INTERVAL_MS`, default 5 min)
  and marks all `open` gigs whose `respondBy` timestamp has passed.

---

## 3. DisputeSaga / DisputeStep

**Source**: `src/dispute/dispute.types.ts`, `src/dispute/dispute-saga.service.ts`  
**Types**: `DisputeStep`, `DisputeVerdict`

### State Diagram

```
  POST /dispute/:escrowId/escalate (API)
          │
          ▼
    ┌────────────┐
    │ ESCALATION │──── (failure) ──────────────────────────────┐
    └─────┬──────┘                                              │
          │ success                                             │
          ▼                                                     │
  ┌──────────────────┐                                          │
  │ JUROR_ASSIGNMENT │──── (failure) ───────────────────────┐  │
  └────────┬─────────┘                                      │  │
           │ POST /dispute/:sagaId/jurors (API)              │  │
           ▼                                                 │  │
       ┌────────┐                                            │  │
       │ VOTING │──── (failure) ───────────────────────┐    │  │
       └───┬────┘                                      │    │  │
           │ POST /dispute/:sagaId/vote (API, per juror) │    │  │
           │ [all jurors voted → verdict computed]      │    │  │
           ▼                                            │    │  │
       ┌────────┐                                       │    │  │
       │ PAYOUT │──── (failure) ─────────────────┐     │    │  │
       └───┬────┘                                │     │    │  │
           │ POST /dispute/:sagaId/payout (API)   │     │    │  │
           ▼                                     │     │    │  │
      ┌───────────┐                              ▼     ▼    ▼  ▼
      │ COMPLETED │                       ┌─────────────────────┐
      └───────────┘                       │    COMPENSATING     │
                                          └──────────┬──────────┘
                                                     │
                                                     ▼
                                               ┌────────┐
                                               │ FAILED │
                                               └────────┘
```

### Transition Table

| From               | To                 | Trigger                                       | Source                                        |
|--------------------|--------------------|-----------------------------------------------|-----------------------------------------------|
| —                  | `ESCALATION`       | `POST /dispute/:escrowId/escalate` (API)      | `DisputeSagaService.escalate()`               |
| `ESCALATION`       | `JUROR_ASSIGNMENT` | Escalation step completes successfully        | `DisputeSagaService.escalate()`               |
| `JUROR_ASSIGNMENT` | `VOTING`           | `POST /dispute/:sagaId/jurors` (API)          | `DisputeSagaService.assignJurors()`           |
| `VOTING`           | `PAYOUT`           | All jurors have voted (majority verdict set)  | `DisputeSagaService.castVote()`               |
| `PAYOUT`           | `COMPLETED`        | `POST /dispute/:sagaId/payout` (API)          | `DisputeSagaService.executePayout()`          |
| any                | `COMPENSATING`     | Step throws an error                          | `DisputeSagaService.compensate*()`            |
| `COMPENSATING`     | `FAILED`           | Compensation recorded                         | `DisputeSagaService.markFailed()`             |

### DisputeVerdict → Escrow Status Mapping

| Verdict            | Escrow outcome | Escrow status after payout |
|--------------------|----------------|----------------------------|
| `BENEFICIARY_WINS` | Full release   | `released`                 |
| `DEPOSITOR_WINS`   | Full cancel    | `cancelled`                |
| `SPLIT`            | Partial split  | `released` (+ splitPercentage) |

### Known Deviations

- **`applyPayout` mutates `Escrow` directly** — `DisputeSagaService.applyPayout()` calls
  `EscrowService.release()`, `cancel()`, or `split()` directly. These calls bypass the
  `disputed → released/cancelled` guard logic that would be expected in a clean state machine,
  because `release()` has no precondition check (see Escrow deviations above).

- **`compensateEscalation` mutates `escrow.status` inline** — the compensating action for a
  failed escalation writes `escrow.status = 'active'` directly on the in-memory object rather
  than going through `EscrowService.applyChainState()`. This bypasses the service layer entirely.

- **`compensatePayout` flags escrow for manual review inline** — casts `escrow` to an ad-hoc
  extended type to set `requiresManualReview = true`. This property is not declared on the
  `Escrow` interface and will be lost on any serialization.

- **`PENDING` step in `DisputeStep` enum is unused** — `DisputeStep.PENDING` is declared in
  `dispute.types.ts` but never set by `DisputeSagaService`. Sagas start at `ESCALATION`.

---

## 4. EventProcessorService — On-Chain Event Mapping

**Source**: `src/event-ingestion/event-processor.service.ts`

| Soroban event type | Off-chain action                                      | Notes                                     |
|--------------------|-------------------------------------------------------|-------------------------------------------|
| `escrow_created`   | `EscrowService.create(depositor, beneficiary, amount)`| Creates a new DB row; no deduplication against existing contract-linked rows |
| `escrow_funded`    | `EscrowService.fund(escrowId)`                        | Uses `event.topic[1]` as off-chain ID; may fail if ID not found |
| `escrow_released`  | `EscrowService.release(escrowId)`                     | Same ID assumption as above              |
| `escrow_disputed`  | `EscrowService.raiseDispute(escrowId, reason)`        | Same ID assumption; `reason` from `event.value.reason` |

### Gaps

- `escrow_created` events create a **new row with a random UUID**, not linked by `contractEscrowId`.
  The reconciler (`EscrowReconciliationService`) has a separate `createFromChainState()` path for
  that, but `EventProcessorService` does not use it — so events and reconciler writes can produce
  duplicate rows for the same on-chain escrow.

- `escrow_funded/released/disputed` use `event.topic[1]` as the off-chain UUID. In practice this
  would be the on-chain contract escrow ID, not the off-chain UUID — these handlers will fail to
  find any matching row unless the IDs happen to match, which they do not by default.

- There is **no reconciliation between `EventProcessorService` and `DisputeSagaService`** — both
  can independently move an escrow to `disputed`. A `dispute.escalate` API call and an incoming
  `escrow_disputed` event for the same escrow will both attempt `raiseDispute()`, with the second
  call throwing a `"Escrow is already disputed"` error (which `EventProcessorService` records as a
  failed event rather than propagating).

---

## 5. Background Workers

| Worker                   | Source                                              | What it drives                           |
|--------------------------|-----------------------------------------------------|------------------------------------------|
| `GigExpiryWorkerService` | `src/gig/gig-expiry-worker.service.ts`              | `open → expired` for overdue gigs        |
| `RepinWorkerService`     | `src/ipfs-pinning/repin-worker.service.ts`          | Calls `IpfsPinningService.reconcile()`   |
| `SorobanEventIndexerService` | `src/soroban-event-indexer/soroban-event-indexer.service.ts` | Polls chain and feeds `EventProcessorService` |
| `EscrowReconciliationWorkerService` | `src/escrow-reconciliation/escrow-reconciliation-worker.service.ts` | Diffs off-chain vs on-chain escrow state |
