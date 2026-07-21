import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import {
  DisputeSaga,
  DisputeStep,
  DisputeVerdict,
  JurorVote,
  SagaStepRecord,
} from './dispute.types';
import { EscalateDisputeDto, AssignJurorsDto, CastVoteDto, ExecutePayoutDto } from './dispute.dto';
import { EscrowService, Escrow } from '../escrow/escrow.service';
import { WebhookService } from '../webhook/webhook.service';
import { DiscordService } from '../webhook/discord.service';

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

@Injectable()
export class DisputeSagaService {
  private readonly logger = new Logger(DisputeSagaService.name);
  /** In-memory saga store — keyed by sagaId */
  private readonly sagas: Map<string, DisputeSaga> = new Map();
  /** Secondary index: escrowId → sagaId (one active saga per escrow) */
  private readonly escrowIndex: Map<string, string> = new Map();

  constructor(
    private readonly escrowService: EscrowService,
    private readonly webhookService: WebhookService,
    private readonly discordService: DiscordService,
  ) {}

  // ─── Queries ──────────────────────────────────────────────────────

  findById(sagaId: string): DisputeSaga {
    const saga = this.sagas.get(sagaId);
    if (!saga) throw new NotFoundException(`Dispute saga ${sagaId} not found`);
    return saga;
  }

  findByEscrowId(escrowId: string): DisputeSaga | undefined {
    const sagaId = this.escrowIndex.get(escrowId);
    return sagaId ? this.sagas.get(sagaId) : undefined;
  }

  findAll(): DisputeSaga[] {
    return [...this.sagas.values()];
  }

  // ─── Step 1: Escalation ───────────────────────────────────────────

  /**
   * Opens a new dispute saga for an escrow.
   * Compensating action: restore escrow status to 'active'.
   */
  async escalate(escrowId: string, dto: EscalateDisputeDto): Promise<DisputeSaga> {
    // Guard: only one active saga per escrow
    const existing = this.findByEscrowId(escrowId);
    if (existing && existing.currentStep !== DisputeStep.FAILED) {
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

      this.sagas.set(sagaId, saga);
      this.escrowIndex.set(escrowId, sagaId);
      this.touch(saga);

      await this.webhookService.dispatch(SAGA_EVENTS.ESCALATED, { sagaId, escrowId });
      await this.discordService.notifyDisputeNeedsJurors({
        escrowId,
        depositor: escrow.depositor,
        beneficiary: escrow.beneficiary,
        amountXLM: escrow.amountXLM,
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
        escrow.status = 'active';
      }
      this.recordStepCompensated(saga, DisputeStep.ESCALATION);
    } catch (compError) {
      this.logger.error(`Saga ${saga.sagaId}: escalation compensation itself failed`, compError);
    }

    this.markFailed(saga, reason);
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
    const saga = this.findById(sagaId);
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

      await this.webhookService.dispatch(SAGA_EVENTS.JURORS_ASSIGNED, {
        sagaId,
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
    const saga = this.findById(sagaId);
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
      }

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
    const saga = this.findById(sagaId);
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

      await this.webhookService.dispatch(SAGA_EVENTS.PAYOUT_EXECUTED, {
        sagaId,
        verdict: saga.verdict,
        payoutTxHash: saga.payoutTxHash,
      });
      await this.webhookService.dispatch(SAGA_EVENTS.SAGA_COMPLETED, { sagaId });

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
        // Funds returned to depositor — mark as cancelled
        {
          const escrow = await this.escrowService.findById(saga.escrowId);
          if (escrow) escrow.status = 'cancelled';
        }
        break;

      case DisputeVerdict.SPLIT:
        // Partial release — use provided split or default 50/50
        {
          const escrow = await this.escrowService.findById(saga.escrowId);
          if (escrow) {
            // Record split metadata; actual on-chain split would be handled by Soroban contract
            (escrow as Escrow & { splitPercentage?: number }).splitPercentage =
              splitPercentage ?? 50;
            escrow.status = 'released';
          }
        }
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
        escrow.status = 'disputed'; // revert to disputed so it isn't lost
        (escrow as Escrow & { requiresManualReview?: boolean }).requiresManualReview = true;
      }
      saga.currentStep = DisputeStep.PAYOUT; // allow retry
      this.recordStepCompensated(saga, DisputeStep.PAYOUT);
    } catch (compError) {
      this.logger.error(`Saga ${saga.sagaId}: payout compensation failed`, compError);
    }

    this.markFailed(saga, reason);
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
}
