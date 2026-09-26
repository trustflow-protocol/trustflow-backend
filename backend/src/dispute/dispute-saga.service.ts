import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  OnModuleInit,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { MetricsService } from '../monitoring/metrics.service';
import {
  DisputeSaga,
  DisputeStep,
  DisputeVerdict,
  JurorVote,
  SagaStepRecord,
} from './dispute.types';
import { EscalateDisputeDto, AssignJurorsDto, CastVoteDto, ExecutePayoutDto } from './dispute.dto';
import { EscrowService } from '../escrow/escrow.service';
import { WebhookService } from '../webhook/webhook.service';
import { NotificationService } from '../notification/notification.service';
import { ReputationOutcome } from '../reputation/reputation.types';

/** Webhook event names emitted by the saga */
export const SAGA_EVENTS = {
  ESCALATED: 'dispute.escalated',
  JURORS_ASSIGNED: 'dispute.jurors_assigned',
  VOTE_CAST: 'dispute.vote_cast',
  VERDICT_REACHED: 'dispute.verdict_reached',
  PAYOUT_EXECUTED: 'dispute.payout_executed',
  SAGA_COMPLETED: 'dispute.saga_completed',
  SAGA_COMPENSATING: 'dispute.saga_compensating',
  SAGA_FAILED: 'dispute.saga_failed',
} as const;

/** Maps a jury verdict onto the domain-neutral outcomes the reputation engine understands. */
const REPUTATION_OUTCOME_BY_VERDICT: Record<
  DisputeVerdict,
  { depositor: ReputationOutcome; beneficiary: ReputationOutcome }
> = {
  [DisputeVerdict.BENEFICIARY_WINS]: { depositor: 'lost', beneficiary: 'won' },
  [DisputeVerdict.DEPOSITOR_WINS]: { depositor: 'won', beneficiary: 'lost' },
  [DisputeVerdict.SPLIT]: { depositor: 'split', beneficiary: 'split' },
};

const SAGA_KEY_PREFIX = 'saga:';
const SAGAS_INDEX_KEY = 'sagas:index';
const SAGAS_BY_ESCROW_PREFIX = 'sagas:by-escrow:';

/** Emitted (see `GET /metrics`) every time a call falls back to the in-memory store. */
export const DISPUTE_SAGA_PERSISTENCE_FALLBACK_METRIC = 'dispute_saga_persistence_fallback_total';

/**
 * Orchestrates the dispute resolution saga (escalation → juror assignment → voting → payout),
 * with a compensating action for every step. Backed by Redis so saga progress survives restarts
 * and is shared across instances — see PERSISTENT_STORAGE_SPIKE.md and its "Follow-up decisions"
 * addendum (#190): losing saga state mid-flight on restart would otherwise leave a dispute stuck
 * between steps with no record of what was already done.
 *
 * Every method that reads a saga then mutates it (`saga.currentStep = ...`, etc.) explicitly
 * persists the change afterward — unlike the original in-memory `Map`, a Redis-backed read
 * returns a freshly deserialized copy, not a live reference, so relying on reference semantics
 * to make a mutation "stick" would silently no-op once the store is Redis-backed.
 *
 * Falls back to a process-local Map when Redis is unavailable, logged at `error` level and
 * counted via `DISPUTE_SAGA_PERSISTENCE_FALLBACK_METRIC`.
 */
@Injectable()
export class DisputeSagaService implements OnModuleInit {
  private readonly logger = new Logger(DisputeSagaService.name);
  /** Fallback saga store, only used while Redis is unavailable. */
  private readonly sagas: Map<string, DisputeSaga> = new Map();
  /** Fallback secondary index: escrowId → sagaId (one active saga per escrow). */
  private readonly escrowIndex: Map<string, string> = new Map();

  constructor(
    private readonly escrowService: EscrowService,
    private readonly webhookService: WebhookService,
    private readonly notificationService: NotificationService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    if (!this.redis && process.env.NODE_ENV === 'production') {
      throw new Error(
        'DisputeSagaService requires REDIS_URL to be configured in production — refusing to ' +
          'start with per-instance in-memory storage, which would silently diverge across instances.',
      );
    }
  }

  // ─── Queries ──────────────────────────────────────────────────────

  async findById(sagaId: string): Promise<DisputeSaga> {
    const saga = await this.tryFindById(sagaId);
    if (!saga) throw new NotFoundException(`Dispute saga ${sagaId} not found`);
    return saga;
  }

  async findByEscrowId(escrowId: string): Promise<DisputeSaga | undefined> {
    if (this.redis) {
      try {
        const sagaId = await this.redis.get(this.escrowIndexKey(escrowId));
        return sagaId ? await this.tryFindById(sagaId) : undefined;
      } catch (err) {
        this.logFallback('findByEscrowId', err);
      }
    }

    const sagaId = this.escrowIndex.get(escrowId);
    return sagaId ? this.sagas.get(sagaId) : undefined;
  }

  async findAll(): Promise<DisputeSaga[]> {
    if (this.redis) {
      try {
        const ids = await this.redis.smembers(SAGAS_INDEX_KEY);
        if (ids.length === 0) return [];
        const raw = await this.redis.mget(...ids.map(id => this.sagaKey(id)));
        return raw.filter((r): r is string => r !== null).map(r => JSON.parse(r) as DisputeSaga);
      } catch (err) {
        this.logFallback('findAll', err);
      }
    }

    return [...this.sagas.values()];
  }

  // ─── Step 1: Escalation ───────────────────────────────────────────

  /**
   * Opens a new dispute saga for an escrow.
   * Compensating action: restore escrow status to 'active'.
   */
  async escalate(escrowId: string, dto: EscalateDisputeDto): Promise<DisputeSaga> {
    // Guard: only one active saga per escrow
    const existing = await this.findByEscrowId(escrowId);
    if (
      existing &&
      existing.currentStep !== DisputeStep.FAILED &&
      existing.currentStep !== DisputeStep.COMPLETED
    ) {
      throw new ConflictException(`An active dispute saga already exists for escrow ${escrowId}`);
    }

    const escrow = await this.escrowService.findById(escrowId);
    if (!escrow) throw new NotFoundException(`Escrow ${escrowId} not found`);
    if (escrow.status === 'released') {
      throw new BadRequestException('Cannot dispute a released escrow');
    }

    const sagaId = `saga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    const saga: DisputeSaga = {
      sagaId,
      escrowId,
      initiator: dto.initiator,
      reason: dto.reason,
      currentStep: DisputeStep.ESCALATION,
      votes: [],
      stepHistory: [],
      createdAt: now,
      updatedAt: now,
    };

    this.recordStepStart(saga, DisputeStep.ESCALATION);

    try {
      // Freeze the escrow by marking it disputed
      await this.escrowService.raiseDispute(escrowId, dto.reason);

      // Simulate on-chain escalation tx hash
      saga.escalationTxHash = `escalation-tx-${sagaId}`;
      this.recordStepComplete(saga, DisputeStep.ESCALATION);
      saga.currentStep = DisputeStep.JUROR_ASSIGNMENT;
      this.touch(saga);

      await this.createSaga(saga);

      await this.webhookService.dispatch(SAGA_EVENTS.ESCALATED, { sagaId, escrowId });
      await this.notificationService.notifyDisputeEscalated({
        escrowId,
        disputeId: sagaId,
        depositor: escrow.depositor,
        beneficiary: escrow.beneficiary,
        reason: dto.reason,
      });

      this.logger.log(`Saga ${sagaId}: escalation complete for escrow ${escrowId}`);
      return saga;
    } catch (error) {
      await this.compensateEscalation(saga, error);
      throw error;
    }
  }

  // ─── Compensating action for Step 1 ──────────────────────────────

  private async compensateEscalation(saga: DisputeSaga, error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    this.logger.warn(`Saga ${saga.sagaId}: compensating escalation — ${reason}`);
    this.recordStepFailed(saga, DisputeStep.ESCALATION, reason);
    saga.currentStep = DisputeStep.COMPENSATING;
    saga.compensationReason = reason;

    try {
      // Compensating action: revert escrow status to active
      const escrow = await this.escrowService.findById(saga.escrowId);
      if (escrow && escrow.status === 'disputed') {
        await this.escrowService.correctStatus(saga.escrowId, { status: 'active' });
      }
      this.recordStepCompensated(saga, DisputeStep.ESCALATION);
    } catch (compError) {
      this.logger.error(`Saga ${saga.sagaId}: escalation compensation itself failed`, compError);
    }

    this.markFailed(saga, reason);
    // The saga never made it past its first successful write on this path, so persist it now.
    await this.persistSaga(saga);
    await this.webhookService.dispatch(SAGA_EVENTS.SAGA_FAILED, {
      sagaId: saga.sagaId,
      reason,
      step: DisputeStep.ESCALATION,
    });
  }

  // ─── Step 2: Juror Assignment ─────────────────────────────────────

  /**
   * Assigns jurors to review the dispute.
   * Compensating action: clear juror list and re-open for assignment.
   */
  async assignJurors(sagaId: string, dto: AssignJurorsDto): Promise<DisputeSaga> {
    const saga = await this.findById(sagaId);
    this.assertStep(saga, DisputeStep.JUROR_ASSIGNMENT);

    this.recordStepStart(saga, DisputeStep.JUROR_ASSIGNMENT);

    try {
      // Deduplicate juror addresses
      const unique = [...new Set(dto.jurors)];
      if (unique.length < 3) {
        throw new BadRequestException('At least 3 distinct juror addresses are required');
      }

      saga.assignedJurors = unique;
      this.recordStepComplete(saga, DisputeStep.JUROR_ASSIGNMENT);
      saga.currentStep = DisputeStep.VOTING;
      this.touch(saga);
      await this.persistSaga(saga);

      await this.webhookService.dispatch(SAGA_EVENTS.JURORS_ASSIGNED, {
        sagaId,
        jurors: unique,
      });
      await this.notificationService.notifyJurorsAssigned({
        disputeId: sagaId,
        escrowId: saga.escrowId,
        jurors: unique,
      });

      this.logger.log(`Saga ${sagaId}: ${unique.length} jurors assigned`);
      return saga;
    } catch (error) {
      await this.compensateJurorAssignment(saga, error);
      throw error;
    }
  }

  // ─── Compensating action for Step 2 ──────────────────────────────

  private async compensateJurorAssignment(saga: DisputeSaga, error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    this.logger.warn(`Saga ${saga.sagaId}: compensating juror assignment — ${reason}`);
    this.recordStepFailed(saga, DisputeStep.JUROR_ASSIGNMENT, reason);
    saga.currentStep = DisputeStep.COMPENSATING;
    saga.compensationReason = reason;

    try {
      // Compensating action: clear the assigned jurors, revert to prior step
      saga.assignedJurors = undefined;
      saga.currentStep = DisputeStep.JUROR_ASSIGNMENT;
      this.recordStepCompensated(saga, DisputeStep.JUROR_ASSIGNMENT);
    } catch (compError) {
      this.logger.error(`Saga ${saga.sagaId}: juror assignment compensation failed`, compError);
    }

    this.markFailed(saga, reason);
    await this.persistSaga(saga);
    await this.webhookService.dispatch(SAGA_EVENTS.SAGA_COMPENSATING, {
      sagaId: saga.sagaId,
      step: DisputeStep.JUROR_ASSIGNMENT,
      reason,
    });
  }

  // ─── Step 3: Voting ───────────────────────────────────────────────

  /**
   * Records a juror vote. When all assigned jurors have voted,
   * the verdict is computed automatically.
   * Compensating action: remove the vote and mark voting as incomplete.
   */
  async castVote(sagaId: string, dto: CastVoteDto): Promise<DisputeSaga> {
    const saga = await this.findById(sagaId);
    this.assertStep(saga, DisputeStep.VOTING);

    if (!saga.assignedJurors?.includes(dto.jurorAddress)) {
      throw new BadRequestException(`${dto.jurorAddress} is not an assigned juror for this saga`);
    }

    if (saga.votes?.some(v => v.jurorAddress === dto.jurorAddress)) {
      throw new ConflictException(`Juror ${dto.jurorAddress} has already voted`);
    }

    this.recordStepStart(saga, DisputeStep.VOTING);

    try {
      const vote: JurorVote = {
        jurorAddress: dto.jurorAddress,
        vote: dto.vote,
        castAt: new Date().toISOString(),
      };
      saga.votes = [...(saga.votes ?? []), vote];
      this.touch(saga);

      await this.webhookService.dispatch(SAGA_EVENTS.VOTE_CAST, {
        sagaId,
        jurorAddress: dto.jurorAddress,
        votesIn: saga.votes.length,
        votesNeeded: saga.assignedJurors!.length,
      });

      // All jurors have voted — compute verdict
      if (saga.votes.length === saga.assignedJurors!.length) {
        const verdict = this.computeVerdict(saga.votes);
        saga.verdict = verdict;
        this.recordStepComplete(saga, DisputeStep.VOTING);
        saga.currentStep = DisputeStep.PAYOUT;

        await this.webhookService.dispatch(SAGA_EVENTS.VERDICT_REACHED, { sagaId, verdict });
        this.logger.log(`Saga ${sagaId}: verdict reached — ${verdict}`);

        const escrow = await this.escrowService.findById(saga.escrowId);
        if (escrow) {
          await this.notificationService.notifyVerdictReached({
            disputeId: sagaId,
            escrowId: saga.escrowId,
            verdict,
            depositor: escrow.depositor,
            beneficiary: escrow.beneficiary,
          });
        }
      }

      await this.persistSaga(saga);
      return saga;
    } catch (error) {
      await this.compensateVoting(saga, dto.jurorAddress, error);
      throw error;
    }
  }

  /** Simple majority vote tally */
  private computeVerdict(votes: JurorVote[]): DisputeVerdict {
    const tally = { depositor: 0, beneficiary: 0, split: 0 };
    for (const v of votes) tally[v.vote]++;

    if (tally.depositor > tally.beneficiary && tally.depositor > tally.split) {
      return DisputeVerdict.DEPOSITOR_WINS;
    }
    if (tally.beneficiary > tally.depositor && tally.beneficiary > tally.split) {
      return DisputeVerdict.BENEFICIARY_WINS;
    }
    return DisputeVerdict.SPLIT;
  }

  // ─── Compensating action for Step 3 ──────────────────────────────

  private async compensateVoting(
    saga: DisputeSaga,
    jurorAddress: string,
    error: unknown,
  ): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    this.logger.warn(`Saga ${saga.sagaId}: compensating vote from ${jurorAddress} — ${reason}`);
    this.recordStepFailed(saga, DisputeStep.VOTING, reason);

    try {
      // Compensating action: remove the problematic vote
      saga.votes = saga.votes?.filter(v => v.jurorAddress !== jurorAddress);
      saga.verdict = undefined;
      this.recordStepCompensated(saga, DisputeStep.VOTING);
    } catch (compError) {
      this.logger.error(`Saga ${saga.sagaId}: voting compensation failed`, compError);
    }

    await this.persistSaga(saga);
    await this.webhookService.dispatch(SAGA_EVENTS.SAGA_COMPENSATING, {
      sagaId: saga.sagaId,
      step: DisputeStep.VOTING,
      reason,
    });
  }

  // ─── Step 4: Payout ───────────────────────────────────────────────

  /**
   * Executes the payout according to the verdict.
   * Compensating action: reverse the release and flag the escrow for manual review.
   */
  async executePayout(sagaId: string, dto: ExecutePayoutDto): Promise<DisputeSaga> {
    const saga = await this.findById(sagaId);
    this.assertStep(saga, DisputeStep.PAYOUT);

    if (!saga.verdict) {
      throw new BadRequestException('Cannot execute payout: no verdict has been recorded');
    }

    this.recordStepStart(saga, DisputeStep.PAYOUT);

    try {
      await this.applyPayout(saga, dto.splitPercentage);

      saga.payoutTxHash = `payout-tx-${sagaId}-${Date.now()}`;
      this.recordStepComplete(saga, DisputeStep.PAYOUT);

      const now = new Date().toISOString();
      saga.currentStep = DisputeStep.COMPLETED;
      saga.completedAt = now;
      this.touch(saga);
      await this.persistSaga(saga);

      await this.webhookService.dispatch(SAGA_EVENTS.PAYOUT_EXECUTED, {
        sagaId,
        verdict: saga.verdict,
        payoutTxHash: saga.payoutTxHash,
      });
      await this.webhookService.dispatch(SAGA_EVENTS.SAGA_COMPLETED, { sagaId });

      const payoutEscrow = await this.escrowService.findById(saga.escrowId);
      if (payoutEscrow) {
        await this.notificationService.notifyPayoutExecuted({
          disputeId: sagaId,
          escrowId: saga.escrowId,
          verdict: saga.verdict,
          depositor: payoutEscrow.depositor,
          beneficiary: payoutEscrow.beneficiary,
        });
      }

      this.logger.log(`Saga ${sagaId}: completed — payout executed for ${saga.verdict}`);
      return saga;
    } catch (error) {
      await this.compensatePayout(saga, error);
      throw error;
    }
  }

  /** Apply the payout by releasing or marking the escrow based on the verdict */
  private async applyPayout(saga: DisputeSaga, splitPercentage?: number): Promise<void> {
    switch (saga.verdict) {
      case DisputeVerdict.BENEFICIARY_WINS:
        await this.escrowService.release(saga.escrowId);
        break;

      case DisputeVerdict.DEPOSITOR_WINS:
        await this.escrowService.cancel(saga.escrowId);
        break;

      case DisputeVerdict.SPLIT:
        await this.escrowService.split(saga.escrowId, splitPercentage ?? 50);
        break;
    }
  }

  // ─── Compensating action for Step 4 ──────────────────────────────

  private async compensatePayout(saga: DisputeSaga, error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    this.logger.warn(`Saga ${saga.sagaId}: compensating payout — ${reason}`);
    this.recordStepFailed(saga, DisputeStep.PAYOUT, reason);
    saga.currentStep = DisputeStep.COMPENSATING;
    saga.compensationReason = reason;

    try {
      // Compensating action: flag escrow for manual admin review
      const escrow = await this.escrowService.findById(saga.escrowId);
      if (escrow) {
        // revert to disputed so it isn't lost, and flag for manual review
        await this.escrowService.correctStatus(saga.escrowId, {
          status: 'disputed',
          requiresManualReview: true,
        });
      }
      saga.currentStep = DisputeStep.PAYOUT; // allow retry
      this.recordStepCompensated(saga, DisputeStep.PAYOUT);
    } catch (compError) {
      this.logger.error(`Saga ${saga.sagaId}: payout compensation failed`, compError);
    }

    this.markFailed(saga, reason);
    await this.persistSaga(saga);
    await this.webhookService.dispatch(SAGA_EVENTS.SAGA_FAILED, {
      sagaId: saga.sagaId,
      step: DisputeStep.PAYOUT,
      reason,
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private assertStep(saga: DisputeSaga, expected: DisputeStep): void {
    if (saga.currentStep === DisputeStep.FAILED) {
      throw new BadRequestException(`Saga ${saga.sagaId} has failed and cannot be advanced`);
    }
    if (saga.currentStep === DisputeStep.COMPLETED) {
      throw new BadRequestException(`Saga ${saga.sagaId} is already completed`);
    }
    if (saga.currentStep !== expected) {
      throw new BadRequestException(
        `Saga ${saga.sagaId} is at step ${saga.currentStep}, expected ${expected}`,
      );
    }
  }

  private touch(saga: DisputeSaga): void {
    saga.updatedAt = new Date().toISOString();
  }

  private markFailed(saga: DisputeSaga, reason: string): void {
    saga.currentStep = DisputeStep.FAILED;
    saga.failedAt = new Date().toISOString();
    saga.compensationReason = reason;
    this.touch(saga);
  }

  private recordStepStart(saga: DisputeSaga, step: DisputeStep): void {
    // Remove any prior incomplete record for the same step (idempotent retry)
    saga.stepHistory = saga.stepHistory.filter(r => !(r.step === step && !r.completedAt));
    saga.stepHistory.push({ step, startedAt: new Date().toISOString() });
  }

  private recordStepComplete(saga: DisputeSaga, step: DisputeStep): void {
    const record = this.lastRecord(saga, step);
    if (record) record.completedAt = new Date().toISOString();
  }

  private recordStepFailed(saga: DisputeSaga, step: DisputeStep, error: string): void {
    const record = this.lastRecord(saga, step);
    if (record) {
      record.failedAt = new Date().toISOString();
      record.error = error;
    }
  }

  private recordStepCompensated(saga: DisputeSaga, step: DisputeStep): void {
    const record = this.lastRecord(saga, step);
    if (record) record.compensatedAt = new Date().toISOString();
  }

  private lastRecord(saga: DisputeSaga, step: DisputeStep): SagaStepRecord | undefined {
    return [...saga.stepHistory].reverse().find(r => r.step === step);
  }

  // ─── Persistence ──────────────────────────────────────────────────

  /** First write for a new saga: entity + index + by-escrow pointer, atomically. */
  private async createSaga(saga: DisputeSaga): Promise<void> {
    if (this.redis) {
      try {
        const results = await this.redis
          .multi()
          .set(this.sagaKey(saga.sagaId), JSON.stringify(saga))
          .sadd(SAGAS_INDEX_KEY, saga.sagaId)
          .set(this.escrowIndexKey(saga.escrowId), saga.sagaId)
          .exec();
        this.assertTransactionOk(results);
        return;
      } catch (err) {
        this.logFallback('createSaga', err);
      }
    }

    this.sagas.set(saga.sagaId, saga);
    this.escrowIndex.set(saga.escrowId, saga.sagaId);
  }

  /** Writes a saga's current field values. Used after every mutation to an already-created saga. */
  private async persistSaga(saga: DisputeSaga): Promise<void> {
    if (this.redis) {
      try {
        const results = await this.redis
          .multi()
          .set(this.sagaKey(saga.sagaId), JSON.stringify(saga))
          .sadd(SAGAS_INDEX_KEY, saga.sagaId)
          .exec();
        this.assertTransactionOk(results);
        return;
      } catch (err) {
        this.logFallback('persistSaga', err);
      }
    }

    this.sagas.set(saga.sagaId, saga);
  }

  private async tryFindById(sagaId: string): Promise<DisputeSaga | undefined> {
    if (this.redis) {
      try {
        const raw = await this.redis.get(this.sagaKey(sagaId));
        return raw ? (JSON.parse(raw) as DisputeSaga) : undefined;
      } catch (err) {
        this.logFallback('findById', err);
      }
    }

    return this.sagas.get(sagaId);
  }

  private assertTransactionOk(results: Array<[Error | null, unknown]> | null): void {
    if (!results) {
      throw new Error('Redis transaction aborted (exec() returned null, e.g. a WATCH conflict)');
    }
    const failed = results.find(([err]) => err);
    if (failed) {
      throw new Error(`Redis transaction command failed: ${failed[0]!.message}`);
    }
  }

  private sagaKey(sagaId: string): string {
    return `${SAGA_KEY_PREFIX}${sagaId}`;
  }

  private escrowIndexKey(escrowId: string): string {
    return `${SAGAS_BY_ESCROW_PREFIX}${escrowId}`;
  }

  private logFallback(operation: string, err: unknown): void {
    this.metrics.increment(DISPUTE_SAGA_PERSISTENCE_FALLBACK_METRIC, { operation });
    this.logger.error(
      `Redis unavailable for disputeSaga.${operation}, falling back to per-instance memory ` +
        '(multi-instance state will diverge until Redis recovers)',
      err instanceof Error ? err.stack : String(err),
    );
  }
}
