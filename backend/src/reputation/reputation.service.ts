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
 *    ever replaying the full event log. Decay is memoryless (a property of exponential
 *    decay), so a read never needs to persist the decayed value back — decaying
 *    directly from the original `lastUpdatedAt`/`score` to "now" gives the exact same
 *    result as decaying in smaller persisted steps. Only `applyContribution` (a write)
 *    persists a new `lastUpdatedAt`/`score`.
 *  - Sybil dampening: each contribution is scaled by 1 / (1 + priorInteractions)
 *    with that specific counterparty — harmonic diminishing returns. Two colluding
 *    addresses looping fake escrows back and forth see their mutual contribution
 *    shrink every round; a wide base of distinct, one-off counterparties does not.
 *  - Self-dealing (depositor === beneficiary) is *not* naturally dampened by the
 *    above: recordEscrowCompleted() applies two contributions for one escrow —
 *    (address, counterparty) then (counterparty, address) — and for a self-escrow
 *    both calls hit the *same* record. The first sees zero prior interactions
 *    with itself (full weight); only the second is halved, so a wallet looping
 *    escrows with itself nets 1.5x what a genuine two-party escrow gives each
 *    side. recordEscrowCompleted()/recordDisputeResolved() explicitly no-op on
 *    depositor === beneficiary instead (see #437) — this is real special-casing,
 *    not an emergent property of the dampening formula above.
 */
@Injectable()
export class ReputationService {
  private readonly logger = new Logger(ReputationService.name);

  /**
   * `ReputationScoreStore` may now be Redis-backed (real I/O), so `applyContribution`'s
   * read → modify → write sequence can no longer rely on running to completion without
   * yielding to the event loop the way it could against the old fully-synchronous
   * in-memory Map (see the removed comment this replaced, and PERSISTENT_STORAGE_SPIKE.md's
   * "Follow-up decisions" addendum). Every contribution is instead run through this single
   * in-process queue, so two "concurrent" callers (e.g. two requests racing to call
   * recordEscrowCompleted at once) never interleave mid-update on the same instance — one
   * call's entire read-modify-write always finishes before the next one starts. This fixes
   * the single-instance race; it does not make the update atomic *across* backend instances
   * (a true cross-instance CAS would need a Lua script or WATCH/MULTI), which is accepted
   * here given reputation score is a derived/informational value, not money-adjacent state
   * like escrow — unlike #187, nothing here calls for that additional complexity.
   */
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: ReputationScoreStore) {}

  async recordEscrowCompleted(escrow: EscrowParties): Promise<void> {
    if (escrow.depositor === escrow.beneficiary) {
      this.logger.debug(
        `Skipping reputation for self-dealing escrow (depositor === beneficiary === ${escrow.depositor})`,
      );
      return;
    }
    const now = new Date();
    await this.applyContribution(
      escrow.depositor,
      escrow.beneficiary,
      ReputationEventType.ESCROW_COMPLETED,
      escrow.amountXLM,
      now,
    );
    await this.applyContribution(
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
    if (escrow.depositor === escrow.beneficiary) {
      this.logger.debug(
        `Skipping reputation for self-dealing escrow (depositor === beneficiary === ${escrow.depositor})`,
      );
      return;
    }
    const now = new Date();
    await this.applyContribution(
      escrow.depositor,
      escrow.beneficiary,
      this.eventForOutcome(depositorOutcome),
      escrow.amountXLM,
      now,
    );
    await this.applyContribution(
      escrow.beneficiary,
      escrow.depositor,
      this.eventForOutcome(beneficiaryOutcome),
      escrow.amountXLM,
      now,
    );
  }

  /** Pure read — decays to "now" without persisting (see the class doc comment on decay). */
  async getScore(address: string): Promise<ReputationScoreView> {
    const existing = await this.store.get(address);
    const record = existing
      ? this.decay(existing, new Date())
      : this.emptyRecord(address, new Date());
    return this.toView(record);
  }

  /** Count of distinct addresses with a materialized score record, for admin/analytics use. */
  async getTrackedAddressCount(): Promise<number> {
    return (await this.store.findAll()).length;
  }

  async getLeaderboard(
    limit: number = REPUTATION_LEADERBOARD_DEFAULT_LIMIT,
  ): Promise<ReputationScoreView[]> {
    const now = new Date();
    const all = await this.store.findAll();
    return all
      .map(record => this.decay(record, now))
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

  /** Runs `fn` after every previously-queued mutation has settled — see the class doc comment. */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(fn, fn);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async applyContribution(
    address: string,
    counterparty: string,
    type: ReputationEventType,
    amountXLM: string,
    now: Date,
  ): Promise<void> {
    await this.withLock(async () => {
      const existing = await this.store.get(address);
      const record = existing ? this.decay(existing, now) : this.emptyRecord(address, now);

      const priorInteractions = record.counterpartyCounts[counterparty] ?? 0;
      const dampeningFactor = 1 / (1 + priorInteractions);
      const contribution =
        REPUTATION_WEIGHTS[type] * this.amountWeight(amountXLM) * dampeningFactor;

      record.score += contribution;
      record.eventCount += 1;
      record.counterpartyCounts[counterparty] = priorInteractions + 1;
      record.recentEvents = [
        { type, counterparty, contribution, occurredAt: now.toISOString() },
        ...record.recentEvents,
      ].slice(0, REPUTATION_RECENT_EVENTS_LIMIT);
      record.lastUpdatedAt = now.toISOString();

      await this.store.save(record);
      this.logger.debug(
        `${address}: ${type} with ${counterparty} contributed ${contribution.toFixed(2)} ` +
          `(dampening ${dampeningFactor.toFixed(2)}) — new score ${record.score.toFixed(2)}`,
      );
    });
  }

  private emptyRecord(address: string, now: Date): ReputationScoreRecord {
    return {
      address,
      score: 0,
      eventCount: 0,
      counterpartyCounts: {},
      recentEvents: [],
      lastUpdatedAt: now.toISOString(),
    };
  }

  /** Returns a copy of `record` with its score exponentially decayed to `now`. Never persists. */
  private decay(record: ReputationScoreRecord, now: Date): ReputationScoreRecord {
    const elapsedMs = now.getTime() - new Date(record.lastUpdatedAt).getTime();
    if (elapsedMs <= 0) return record;

    const decayFactor = Math.pow(0.5, elapsedMs / REPUTATION_DECAY_HALF_LIFE_MS);
    return {
      ...record,
      score: record.score * decayFactor,
    };
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
