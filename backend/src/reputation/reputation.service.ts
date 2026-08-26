import { Injectable, Logger } from '@nestjs/common';
import { ReputationScoreStore } from './reputation-score.store';
import {
  EscrowParties,
  REPUTATION_DECAY_HALF_LIFE_MS,
  REPUTATION_LEADERBOARD_DEFAULT_LIMIT,
  REPUTATION_MAX_AMOUNT_WEIGHT,
  REPUTATION_RECENT_EVENTS_LIMIT,
  REPUTATION_WEIGHTS,
  ReputationEventType,
  ReputationOutcome,
  ReputationScoreRecord,
  ReputationScoreView,
} from './reputation.types';

/**
 * Computes Sybil-resistant, time-decayed trust scores from escrow completion and
 * dispute-resolution history.
 *
 * Each address has a single materialized ReputationScoreRecord that is updated
 * incrementally — O(1) per event — rather than recomputed from the full event
 * history on every write or read:
 *  - Time decay: the stored score is exponentially decayed to "now" (half-life
 *    REPUTATION_DECAY_HALF_LIFE_MS) before any new contribution is added, or before
 *    being returned on read. Stale history stops dominating current trust without
 *    ever replaying the full event log.
 *  - Sybil dampening: each contribution is scaled by 1 / (1 + priorInteractions)
 *    with that specific counterparty — harmonic diminishing returns. Two colluding
 *    addresses looping fake escrows back and forth see their mutual contribution
 *    shrink every round; a wide base of distinct, one-off counterparties does not.
 *    This also naturally dampens self-dealing (depositor === beneficiary), since
 *    the two sides of that single escrow already count as a repeat interaction
 *    with each other — no special-casing required.
 */
@Injectable()
export class ReputationService {
  private readonly logger = new Logger(ReputationService.name);

  constructor(private readonly store: ReputationScoreStore) {}

  async recordEscrowCompleted(escrow: EscrowParties): Promise<void> {
    const now = new Date();
    this.applyContribution(
      escrow.depositor,
      escrow.beneficiary,
      ReputationEventType.ESCROW_COMPLETED,
      escrow.amountXLM,
      now,
    );
    this.applyContribution(
      escrow.beneficiary,
      escrow.depositor,
      ReputationEventType.ESCROW_COMPLETED,
      escrow.amountXLM,
      now,
    );
  }

  async recordDisputeResolved(
    escrow: EscrowParties,
    depositorOutcome: ReputationOutcome,
    beneficiaryOutcome: ReputationOutcome,
  ): Promise<void> {
    const now = new Date();
    this.applyContribution(
      escrow.depositor,
      escrow.beneficiary,
      this.eventForOutcome(depositorOutcome),
      escrow.amountXLM,
      now,
    );
    this.applyContribution(
      escrow.beneficiary,
      escrow.depositor,
      this.eventForOutcome(beneficiaryOutcome),
      escrow.amountXLM,
      now,
    );
  }

  getScore(address: string): ReputationScoreView {
    return this.toView(this.decayedRecord(address, new Date()));
  }

  /** Count of distinct addresses with a materialized score record, for admin/analytics use. */
  getTrackedAddressCount(): number {
    return this.store.findAll().length;
  }

  getLeaderboard(limit: number = REPUTATION_LEADERBOARD_DEFAULT_LIMIT): ReputationScoreView[] {
    const now = new Date();
    return this.store
      .findAll()
      .map(record => this.decayedRecord(record.address, now))
      .sort(
        (a, b) =>
          b.score - a.score || b.eventCount - a.eventCount || a.address.localeCompare(b.address),
      )
      .slice(0, limit)
      .map(record => this.toView(record));
  }

  private eventForOutcome(outcome: ReputationOutcome): ReputationEventType {
    switch (outcome) {
      case 'won':
        return ReputationEventType.DISPUTE_WON;
      case 'lost':
        return ReputationEventType.DISPUTE_LOST;
      case 'split':
        return ReputationEventType.DISPUTE_SPLIT;
    }
  }

  /**
   * Concurrency note: this method's read (decayedRecord) → modify → write (store.save) sequence
   * has no `await` anywhere in it, and neither does decayedRecord. A synchronous function body in
   * Node runs to completion before the event loop yields to any other queued callback, so two
   * "concurrent" callers (e.g. two requests racing to call recordEscrowCompleted at once) can never
   * interleave mid-update here — one call's entire read-modify-write always finishes before the
   * next one starts, even though the enclosing recordEscrowCompleted/recordDisputeResolved methods
   * are declared `async`. See the "applies concurrent updates without losing contributions" spec
   * for a test that exercises this directly. This guarantee is specific to the current in-memory,
   * fully-synchronous ReputationScoreStore — if that store is ever swapped for one backed by real
   * I/O (a database, a network call), an `await` would be introduced between the read and the write
   * here, and this method would need an optimistic-concurrency guard (e.g. a version/CAS check on
   * save) to keep this property.
   */
  private applyContribution(
    address: string,
    counterparty: string,
    type: ReputationEventType,
    amountXLM: string,
    now: Date,
  ): void {
    const record = this.decayedRecord(address, now);

    const priorInteractions = record.counterpartyCounts[counterparty] ?? 0;
    const dampeningFactor = 1 / (1 + priorInteractions);
    const contribution = REPUTATION_WEIGHTS[type] * this.amountWeight(amountXLM) * dampeningFactor;

    record.score += contribution;
    record.eventCount += 1;
    record.counterpartyCounts[counterparty] = priorInteractions + 1;
    record.recentEvents = [
      { type, counterparty, contribution, occurredAt: now.toISOString() },
      ...record.recentEvents,
    ].slice(0, REPUTATION_RECENT_EVENTS_LIMIT);
    record.lastUpdatedAt = now.toISOString();

    this.store.save(record);
    this.logger.debug(
      `${address}: ${type} with ${counterparty} contributed ${contribution.toFixed(2)} ` +
        `(dampening ${dampeningFactor.toFixed(2)}) — new score ${record.score.toFixed(2)}`,
    );
  }

  /** Returns `address`'s record decayed to `now`, persisting the decayed value. Never persists a freshly-created zero record. */
  private decayedRecord(address: string, now: Date): ReputationScoreRecord {
    const existing = this.store.get(address);
    if (!existing) {
      return {
        address,
        score: 0,
        eventCount: 0,
        counterpartyCounts: {},
        recentEvents: [],
        lastUpdatedAt: now.toISOString(),
      };
    }

    const elapsedMs = now.getTime() - new Date(existing.lastUpdatedAt).getTime();
    if (elapsedMs <= 0) return existing;

    const decayFactor = Math.pow(0.5, elapsedMs / REPUTATION_DECAY_HALF_LIFE_MS);
    const decayed: ReputationScoreRecord = {
      ...existing,
      score: existing.score * decayFactor,
      lastUpdatedAt: now.toISOString(),
    };
    this.store.save(decayed);
    return decayed;
  }

  private amountWeight(amountXLM: string): number {
    const amount = Number(amountXLM);
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    return Math.min(Math.sqrt(amount), REPUTATION_MAX_AMOUNT_WEIGHT);
  }

  private toView(record: ReputationScoreRecord): ReputationScoreView {
    return {
      address: record.address,
      score: Math.round(record.score * 100) / 100,
      eventCount: record.eventCount,
      distinctCounterparties: Object.keys(record.counterpartyCounts).length,
      recentEvents: record.recentEvents,
      lastUpdatedAt: record.lastUpdatedAt,
    };
  }
}
