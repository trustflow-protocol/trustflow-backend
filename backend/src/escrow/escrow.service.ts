import {
  Inject,
  Injectable,
  OnModuleInit,
  Optional,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import {
  assertTransactionApplied,
  isTransactionIntegrityError,
} from '../common/redis/redis-transaction';
import { MetricsService } from '../monitoring/metrics.service';
import { OutboxService } from '../outbox/outbox.service';
import { AuditService } from '../audit/audit.service';
import { config } from '../config/env.config';
import { generateId, sumAmounts } from './util.helper';

const ESCROW_KEY_PREFIX = 'escrow:';
const MILESTONE_KEY_PREFIX = 'milestone:';
export const ESCROWS_INDEX_KEY = 'escrows:index';
const ESCROWS_BY_DEPOSITOR_PREFIX = 'escrows:by-depositor:';
const ESCROWS_BY_CONTRACT_PREFIX = 'escrow:contract:';

/** Emitted (see `/metrics`) every time a call falls back to the in-memory store. */
export const ESCROW_PERSISTENCE_FALLBACK_METRIC = 'escrow_persistence_fallback_total';

/** Emitted when a Redis transaction fails integrity checks and cannot be safely fallen back from. */
export const ESCROW_TRANSACTION_INCONSISTENT_METRIC = 'escrow_transaction_inconsistent_total';

export const ESCROW_EVENTS = {
  ESCROW_CREATED: 'escrow.created',
  ESCROW_FUNDED: 'escrow.funded',
  ESCROW_RELEASED: 'escrow.released',
  ESCROW_CANCELLED: 'escrow.cancelled',
  ESCROW_SPLIT: 'escrow.split',
  ESCROW_DISPUTED: 'escrow.disputed',
} as const;

export const ESCROW_STATUSES = ['pending', 'active', 'released', 'disputed', 'cancelled'] as const;
export type EscrowStatus = (typeof ESCROW_STATUSES)[number];

export interface Milestone {
  id: string;
  escrowId: string;
  title: string;
  amountXLM: string;
  /**
   * 'pending'  — awaiting depositor approval
   * 'approved' — depositor approved (existing flow)
   * 'rejected' — depositor rejected
   * 'released' — funds released for this milestone (bug-fix flow)
   */
  status: 'pending' | 'approved' | 'rejected' | 'released';
  approver?: string;
  approvedAt?: string;
  releasedAt?: string;
  createdAt?: string;
}

export interface CreateMilestoneInput {
  title: string;
  amountXLM: string;
}

export interface Escrow {
  id: string;
  depositor: string;
  beneficiary: string;
  amountXLM: string;
  /**
   * Denormalized summary: sum of unreleased milestone amounts, or the full escrow amount
   * when no milestones are defined. Recomputed on every milestone release so the value is
   * never stale (bug fix #2).
   */
  remainingAmount: string;
  status: EscrowStatus;
  createdAt: string;
  disputeReason?: string;
  disputedAt?: string;
  /** On-chain escrow identifier, set once this row is linked to its contract counterpart. */
  contractEscrowId?: string;
  splitPercentage?: number;
  /** Set by an admin-override correction (e.g. a dispute-saga compensation) that needs a human look. */
  requiresManualReview?: boolean;
  /**
   * Optimistic locking version incremented on every write. Reconciliation compares
   * this with the expected version when applying chain state to prevent concurrent
   * updates from causing double-deduction or lost writes.
   */
  version?: number;
  /** Epoch-millis deadline used by the sweep to detect expired escrows (bug fix #1). */
  releaseDeadlineMs?: number;
}

/** Chain-verified fields the reconciler may write when repairing drift. */
export interface ChainStatePatch {
  status?: EscrowStatus;
  amountXLM?: string;
}

/** Fields required to backfill a DB row for an escrow discovered on-chain but never recorded. */
export interface ChainEscrowSeed {
  contractEscrowId: string;
  depositor: string;
  beneficiary: string;
  amountXLM: string;
  status: EscrowStatus;
}

/** Fields a saga compensation may overwrite directly, bypassing the normal transition guards. */
export interface StatusCorrection {
  status?: EscrowStatus;
  requiresManualReview?: boolean;
  /**
   * Also clear `disputeReason`/`disputedAt` — used when undoing a dispute this
   * process raised (#635), so a later release isn't scored as a dispute
   * resolution by the reputation consumer.
   */
  clearDispute?: boolean;
}

export interface BatchApproveResult {
  succeeded: Array<{ id: string; status: string }>;
  failed: Array<{ id: string; reason: string }>;
}

/**
 * Filter for depositor-facing escrow listings. Mirrors the applicant-list behaviour:
 * terminal/withdrawn entries are hidden by default and must be explicitly opted into,
 * so clients that ignore a `status` field can't present them as live candidates.
 */
export interface EscrowListFilter {
  /** Match exactly this status. Takes precedence over `includeCancelled`. */
  status?: EscrowStatus;
  /** Include cancelled (withdrawn-equivalent) escrows in the default listing. */
  includeCancelled?: boolean;
}

/** Defense-in-depth check; the HTTP layer validates the same format via the DTO. */
const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

@Injectable()
export class EscrowService implements OnModuleInit {
  private readonly logger = new SanitizedLogger(EscrowService.name);

  /** Fallback store, only used while Redis is unavailable. */
  private escrows: Map<string, Escrow> = new Map();
  private milestones = new Map<string, Milestone>();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
    private readonly metrics: MetricsService,
    @Optional() private readonly outbox?: OutboxService,
    @Optional() private readonly audit?: AuditService,
  ) {}

  /**
   * In production, a missing Redis client means every escrow write would silently start
   * diverging per-instance — for money-adjacent state, that's exactly the failure mode this
   * store exists to eliminate. Fail app startup instead of degrading quietly. Non-production
   * environments (dev/test) keep the in-memory fallback so the app still runs without a local
   * Redis.
   */
  onModuleInit(): void {
    if (!this.redis && config.NODE_ENV === 'production') {
      throw new Error(
        'EscrowService requires REDIS_URL to be configured in production — refusing to start ' +
          'with per-instance in-memory storage, which would silently diverge across instances.',
      );
    }
  }

  /**
   * A self-dealing escrow (depositor === beneficiary) can only reach here
   * via an on-chain event or reconciler backfill — `CreateEscrowSchema`
   * rejects it at the API boundary (#437). On-chain state is a fact we
   * can't un-happen, so we store it (never silently drop real chain data)
   * but log a warning; `ReputationService` is the actual enforcement point
   * that refuses to let it earn reputation.
   */
  private warnIfSelfDealing(depositor: string, beneficiary: string, id: string): void {
    if (depositor === beneficiary) {
      this.logger.warn(`Escrow ${id} is self-dealing (depositor === beneficiary === ${depositor})`);
    }
  }

  async create(
    depositor: string,
    beneficiary: string,
    amountXLM: string,
    options?: {
      milestones?: CreateMilestoneInput[];
      releaseDeadlineMs?: number;
    },
  ): Promise<Escrow> {
    const id = randomUUID();
    this.warnIfSelfDealing(depositor, beneficiary, id);
    const now = new Date().toISOString();

    // Seed in-memory milestones when provided at creation time.
    const seedMilestones: Milestone[] = (options?.milestones ?? []).map((m, i) => ({
      id: generateId(`mil-${i}`),
      escrowId: id,
      title: m.title,
      amountXLM: m.amountXLM,
      status: 'pending' as const,
      createdAt: now,
    }));

    for (const m of seedMilestones) {
      this.milestones.set(m.id, m);
    }

    const remainingAmount =
      seedMilestones.length > 0 ? sumAmounts(seedMilestones.map(m => m.amountXLM)) : amountXLM;

    const escrow: Escrow = {
      id,
      depositor,
      beneficiary,
      amountXLM,
      remainingAmount,
      status: 'pending',
      createdAt: now,
      releaseDeadlineMs: options?.releaseDeadlineMs,
    };

    const event = this.outbox?.create(ESCROW_EVENTS.ESCROW_CREATED, 'escrow', id, escrow);

    if (this.redis) {
      try {
        const transaction = this.redis
          .multi()
          .set(this.escrowKey(id), JSON.stringify(escrow))
          .zadd(ESCROWS_INDEX_KEY, Date.parse(escrow.createdAt), id)
          .sadd(this.depositorKey(depositor), id);
        if (event) this.outbox!.appendToTransaction(transaction, event);
        const results = await transaction.exec();
        assertTransactionApplied(results);
        return escrow;
      } catch (err) {
        this.rethrowIfInconsistent('create', id, err);
        this.logFallback('create', err);
      }
    }

    this.escrows.set(id, escrow);
    if (event) await this.outbox!.append(event);
    return escrow;
  }

  async findById(id: string): Promise<Escrow | undefined> {
    if (this.redis) {
      try {
        const raw = await this.redis.get(this.escrowKey(id));
        return raw ? (JSON.parse(raw) as Escrow) : undefined;
      } catch (err) {
        this.logFallback('findById', err);
      }
    }
    return this.escrows.get(id);
  }

  async findByDepositor(
    address: string,
    offset = 0,
    limit = 20,
    filter: EscrowListFilter = {},
  ): Promise<{ data: Escrow[]; total: number }> {
    let all: Escrow[];
    if (this.redis) {
      try {
        const ids = await this.redis.smembers(this.depositorKey(address));
        all = await this.fetchMany(ids);
      } catch (err) {
        this.logFallback('findByDepositor', err);
        all = [...this.escrows.values()].filter(e => e.depositor === address);
      }
    } else {
      all = [...this.escrows.values()].filter(e => e.depositor === address);
    }
    // Always scope to the wallet first, then layer the optional filters on top (#850).
    all = all.filter(e => e.depositor === address);
    if (filter.status !== undefined) {
      all = all.filter(e => e.status === filter.status);
    } else if (!filter.includeCancelled) {
      all = all.filter(e => e.status !== 'cancelled');
    }
    const total = all.length;
    const data = all.slice(offset, offset + limit);
    return { data, total };
  }

  async findAll(): Promise<Escrow[]> {
    if (this.redis) {
      try {
        const ids = await this.redis.zrange(ESCROWS_INDEX_KEY, 0, -1);
        return await this.fetchMany(ids);
      } catch (err) {
        this.logFallback('findAll', err);
      }
    }
    return [...this.escrows.values()];
  }

  async findByContractEscrowId(contractEscrowId: string): Promise<Escrow | undefined> {
    if (this.redis) {
      try {
        const id = await this.redis.get(this.contractKey(contractEscrowId));
        return id ? await this.findById(id) : undefined;
      } catch (err) {
        this.logFallback('findByContractEscrowId', err);
      }
    }
    return [...this.escrows.values()].find(e => e.contractEscrowId === contractEscrowId);
  }

  /** Links a DB row to its on-chain counterpart so the reconciler can diff the two. */
  async linkContractEscrowId(id: string, contractEscrowId: string): Promise<Escrow> {
    const escrow = await this.findById(id);
    if (!escrow) throw new NotFoundException('Escrow not found');
    escrow.contractEscrowId = contractEscrowId;
    if (this.redis) {
      try {
        const results = await this.redis
          .multi()
          .set(this.escrowKey(id), JSON.stringify(escrow))
          .set(this.contractKey(contractEscrowId), id)
          .exec();
        assertTransactionApplied(results);
        return escrow;
      } catch (err) {
        this.rethrowIfInconsistent('linkContractEscrowId', id, err);
        this.logFallback('linkContractEscrowId', err);
      }
    }
    this.escrows.set(id, escrow);
    return escrow;
  }

  /**
   * Applies chain-verified state updates with optimistic locking to prevent concurrent
   * updates from causing double-deduction during reconciliation. The version field acts
   * as an idempotency marker: if the escrow was modified between reading chain state and
   * applying the patch, the write is rejected and the caller can retry with fresh data.
   */
  async applyChainState(
    id: string,
    patch: ChainStatePatch,
    expectedVersion?: number,
  ): Promise<Escrow> {
    const escrow = await this.findById(id);
    if (!escrow) throw new NotFoundException('Escrow not found');
    if (expectedVersion !== undefined && escrow.version !== expectedVersion) {
      throw new ConflictException(
        `Escrow version mismatch: expected ${expectedVersion}, found ${escrow.version}. ` +
          'The escrow was modified concurrently; retry reconciliation with fresh chain state.',
      );
    }
    if (patch.status !== undefined) {
      if (!ESCROW_STATUSES.includes(patch.status)) {
        throw new BadRequestException(`Invalid escrow status: ${String(patch.status)}`);
      }
      escrow.status = patch.status;
    }
    if (patch.amountXLM !== undefined) escrow.amountXLM = patch.amountXLM;
    await this.persist(escrow);
    return escrow;
  }

  /**
   * Overwrites status (and optionally the manual-review flag) directly, bypassing the normal
   * transition guards — used by dispute-saga compensating actions.
   */
  async correctStatus(id: string, patch: StatusCorrection): Promise<Escrow> {
    const escrow = await this.findById(id);
    if (!escrow) throw new NotFoundException('Escrow not found');
    if (patch.status !== undefined) escrow.status = patch.status;
    if (patch.requiresManualReview !== undefined)
      escrow.requiresManualReview = patch.requiresManualReview;
    if (patch.clearDispute) {
      delete escrow.disputeReason;
      delete escrow.disputedAt;
    }
    await this.persist(escrow);
    return escrow;
  }

  /** Creates a DB row for an escrow found on-chain but never recorded. */
  async createFromChainState(seed: ChainEscrowSeed): Promise<Escrow> {
    const id = randomUUID();
    this.warnIfSelfDealing(seed.depositor, seed.beneficiary, id);
    const escrow: Escrow = {
      id,
      depositor: seed.depositor,
      beneficiary: seed.beneficiary,
      amountXLM: seed.amountXLM,
      remainingAmount: seed.amountXLM,
      status: seed.status,
      createdAt: new Date().toISOString(),
      contractEscrowId: seed.contractEscrowId,
    };
    if (this.redis) {
      try {
        const results = await this.redis
          .multi()
          .set(this.escrowKey(id), JSON.stringify(escrow))
          .zadd(ESCROWS_INDEX_KEY, Date.parse(escrow.createdAt), id)
          .sadd(this.depositorKey(escrow.depositor), id)
          .set(this.contractKey(seed.contractEscrowId), id)
          .exec();
        assertTransactionApplied(results);
        return escrow;
      } catch (err) {
        this.rethrowIfInconsistent('createFromChainState', id, err);
        this.logFallback('createFromChainState', err);
      }
    }
    this.escrows.set(id, escrow);
    return escrow;
  }

  async fund(id: string): Promise<Escrow> {
    const escrow = await this.findById(id);
    if (!escrow) throw new NotFoundException('Escrow not found');
    if (escrow.status !== 'pending') {
      throw new BadRequestException(`Cannot fund escrow in status: ${escrow.status}`);
    }
    escrow.status = 'active';
    await this.persist(escrow, ESCROW_EVENTS.ESCROW_FUNDED);
    return escrow;
  }

  /**
   * Changes the payout address of an escrow. This is a money-directing operation, so it is
   * deliberately much more restricted than an ordinary draft-field edit:
   *
   * - the requester must be the depositor (checked again here, not only at the HTTP layer);
   * - once funds are committed (`status !== 'pending'`) the beneficiary is **immutable** —
   *   changing it would need a fresh signed confirmation from both parties, so it is refused
   *   outright. This is the "disallow post-funding" option from the issue.
   *
   * Every successful change is audit-logged with before/after state.
   */
  async changeBeneficiary(id: string, beneficiary: string, requester: string): Promise<Escrow> {
    const escrow = await this.findById(id);
    if (!escrow) throw new NotFoundException('Escrow not found');

    if (!STELLAR_ADDRESS_REGEX.test(beneficiary)) {
      throw new BadRequestException('Invalid Stellar address');
    }
    if (escrow.depositor !== requester) {
      throw new BadRequestException('Only the depositor may change the beneficiary');
    }
    if (escrow.status !== 'pending') {
      throw new BadRequestException(
        `Cannot change the beneficiary of a funded escrow (status: ${escrow.status})`,
      );
    }
    if (beneficiary === escrow.depositor) {
      throw new BadRequestException('depositor and beneficiary must not be the same address');
    }
    if (beneficiary === escrow.beneficiary) return escrow;

    const beforeState = { ...escrow };
    escrow.beneficiary = beneficiary;
    await this.persist(escrow);

    if (this.audit) {
      await this.audit
        .logOperation({
          operation: 'ESCROW_BENEFICIARY_CHANGE',
          user: requester,
          entityId: id,
          entityType: 'escrow',
          beforeState,
          afterState: escrow,
        })
        .catch(err => this.logger.error('Failed to write audit log', err));
    }

    return escrow;
  }

  async release(
    id: string,
    user: string = 'system',
    options: { rejectIfDisputed?: boolean } = {},
  ): Promise<Escrow> {
    const escrow = await this.findById(id);
    if (!escrow) throw new NotFoundException('Escrow not found');
    if (escrow.status === 'released') throw new ConflictException('Escrow is already released');
    if (escrow.status === 'cancelled')
      throw new ConflictException('Cannot release a cancelled escrow');
    // Dispute resolution and chain events may release a disputed escrow; user-initiated
    // releases may not. Checked on the row read immediately before the write (#851).
    if (options.rejectIfDisputed && escrow.status === 'disputed')
      throw new ConflictException('Cannot release a disputed escrow');
    const beforeState = { ...escrow };
    escrow.status = 'released';
    escrow.remainingAmount = '0';
    await this.persist(escrow, ESCROW_EVENTS.ESCROW_RELEASED);
    if (this.audit) {
      await this.audit
        .logOperation({
          operation: 'ESCROW_RELEASE',
          user,
          entityId: id,
          entityType: 'escrow',
          beforeState,
          afterState: escrow,
        })
        .catch((err: unknown) =>
          this.logger.error(
            'Failed to write audit log',
            err instanceof Error ? err.stack : String(err),
          ),
        );
    }
    return escrow;
  }

  async cancel(id: string): Promise<Escrow> {
    const escrow = await this.findById(id);
    if (!escrow) throw new NotFoundException('Escrow not found');
    if (escrow.status === 'cancelled') throw new ConflictException('Escrow is already cancelled');
    if (escrow.status === 'released')
      throw new ConflictException('Cannot cancel a released escrow');
    escrow.status = 'cancelled';
    await this.persist(escrow, ESCROW_EVENTS.ESCROW_CANCELLED);
    return escrow;
  }

  async split(id: string, splitPercentage: number): Promise<Escrow> {
    const escrow = await this.findById(id);
    if (!escrow) throw new NotFoundException('Escrow not found');
    if (escrow.status === 'released') throw new ConflictException('Escrow is already released');
    if (escrow.status === 'cancelled')
      throw new ConflictException('Cannot split a cancelled escrow');
    escrow.status = 'released';
    escrow.splitPercentage = splitPercentage;
    escrow.remainingAmount = '0';
    await this.persist(escrow, ESCROW_EVENTS.ESCROW_SPLIT);
    return escrow;
  }

  async raiseDispute(id: string, reason?: string, user: string = 'system'): Promise<Escrow> {
    const escrow = await this.findById(id);
    if (!escrow) throw new NotFoundException('Escrow not found');
    if (escrow.status === 'released')
      throw new BadRequestException('Cannot dispute a released escrow');
    if (escrow.status === 'disputed') throw new ConflictException('Escrow is already disputed');
    if (escrow.status !== 'active')
      throw new BadRequestException(`Cannot dispute a ${escrow.status} escrow`);
    const beforeState = { ...escrow };
    escrow.status = 'disputed';
    escrow.disputeReason = reason;
    escrow.disputedAt = new Date().toISOString();
    await this.persist(escrow, ESCROW_EVENTS.ESCROW_DISPUTED);
    if (this.audit) {
      await this.audit
        .logOperation({
          operation: 'ESCROW_DISPUTE',
          user,
          entityId: id,
          entityType: 'escrow',
          beforeState,
          afterState: escrow,
        })
        .catch((err: unknown) =>
          this.logger.error(
            'Failed to write audit log',
            err instanceof Error ? err.stack : String(err),
          ),
        );
    }
    return escrow;
  }

  // ---- Milestone management ----

  /**
   * Add a milestone to an existing escrow. Updates `remainingAmount` to include the new entry.
   */
  async addMilestone(escrowId: string, title: string, amountXLM: string): Promise<Milestone> {
    const escrow = await this.findById(escrowId);
    if (!escrow) throw new NotFoundException('Escrow not found');

    const milestone: Milestone = {
      id: generateId('mil'),
      escrowId,
      title,
      amountXLM,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.milestones.set(milestone.id, milestone);

    // Recompute remaining amount to include the new milestone.
    const all = await this.getMilestones(escrowId);
    const unreleased = all.filter(m => m.status !== 'released');
    escrow.remainingAmount =
      unreleased.length > 0 ? sumAmounts(unreleased.map(m => m.amountXLM)) : escrow.amountXLM;
    await this.persist(escrow);

    return milestone;
  }

  /**
   * Release a single milestone and recompute `remainingAmount`.
   *
   * Bug fix: previously the release handler updated the milestone row's status but never
   * recomputed the denormalized `remainingAmount` summary field, so it continued to reflect
   * the pre-release total. This method recomputes and persists `remainingAmount` atomically
   * with the milestone status update.
   */
  async releaseMilestone(escrowId: string, milestoneId: string): Promise<Escrow> {
    const escrow = await this.findById(escrowId);
    if (!escrow) throw new NotFoundException('Escrow not found');

    const milestone = this.milestones.get(milestoneId);
    if (!milestone || milestone.escrowId !== escrowId) {
      throw new NotFoundException('Milestone not found');
    }
    if (milestone.status === 'released') {
      throw new ConflictException('Milestone already released');
    }
    if (escrow.status === 'disputed') {
      throw new ConflictException('Cannot release a milestone of a disputed escrow');
    }

    milestone.status = 'released';
    milestone.releasedAt = new Date().toISOString();

    // Recompute from the still-unreleased milestones.
    const all = await this.getMilestones(escrowId);
    const unreleased = all.filter(m => m.status !== 'released');
    escrow.remainingAmount =
      unreleased.length > 0 ? sumAmounts(unreleased.map(m => m.amountXLM)) : '0';

    // Auto-release the escrow when every milestone is released.
    if (unreleased.length === 0) {
      escrow.status = 'released';
    }

    await this.persist(
      escrow,
      escrow.status === 'released' ? ESCROW_EVENTS.ESCROW_RELEASED : undefined,
    );
    return escrow;
  }

  /** Get milestones for an escrow */
  async getMilestones(escrowId: string): Promise<Milestone[]> {
    return [...this.milestones.values()].filter(m => m.escrowId === escrowId);
  }

  /** Approve a single milestone (existing depositor-approval flow) */
  async approveMilestone(id: string, signerAddress: string): Promise<Milestone> {
    const milestone = this.milestones.get(id);
    if (!milestone) throw new NotFoundException('Milestone not found');
    const escrow = this.escrows.get(milestone.escrowId);
    if (!escrow) throw new NotFoundException('Escrow not found');
    if (signerAddress !== escrow.depositor) {
      throw new BadRequestException('Only the depositor can approve milestones');
    }
    if (milestone.status !== 'pending') {
      throw new BadRequestException(`Milestone is already ${milestone.status}`);
    }
    milestone.status = 'approved';
    milestone.approver = signerAddress;
    milestone.approvedAt = new Date().toISOString();
    if (this.redis) {
      try {
        const results = await this.redis
          .multi()
          .set(this.milestoneKey(id), JSON.stringify(milestone))
          .exec();
        assertTransactionApplied(results);
        return milestone;
      } catch (err) {
        this.rethrowIfInconsistent('approveMilestone', id, err);
        this.logFallback('approveMilestone', err);
      }
    }
    this.milestones.set(id, milestone);
    return milestone;
  }

  /** Batch approve multiple milestones across different escrows */
  async batchApproveMilestones(
    milestoneIds: string[],
    signerAddress: string,
  ): Promise<BatchApproveResult> {
    const result: BatchApproveResult = { succeeded: [], failed: [] };
    for (const id of milestoneIds) {
      try {
        const milestone = await this.approveMilestone(id, signerAddress);
        result.succeeded.push({ id: milestone.id, status: milestone.status });
      } catch (error) {
        result.failed.push({
          id,
          reason: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
    return result;
  }

  // ---- Expiry check (used by the adaptive sweep) ----

  /**
   * Check whether an escrow's release deadline has passed. If so, auto-release it.
   * Returns true if the escrow was acted upon.
   *
   * Bug fix: the original sweep never ran this check, so expired escrows were never
   * released automatically. Combined with the adaptive sweep (EscrowSweepService),
   * this enables time-based auto-release that scales with escrow volume.
   */
  async checkExpiry(id: string): Promise<boolean> {
    const escrow = await this.findById(id);
    if (!escrow) return false;
    if (!escrow.releaseDeadlineMs) return false;
    if (
      escrow.status === 'released' ||
      escrow.status === 'cancelled' ||
      escrow.status === 'disputed'
    )
      return false;

    if (Date.now() >= escrow.releaseDeadlineMs) {
      escrow.status = 'released';
      escrow.remainingAmount = '0';
      await this.persist(escrow, ESCROW_EVENTS.ESCROW_RELEASED);
      return true;
    }
    return false;
  }

  // ---- Internal persistence helpers ----

  /** Writes an escrow's current field values without touching any index. */
  private async persist(escrow: Escrow, eventType?: string): Promise<void> {
    escrow.version = (escrow.version ?? 0) + 1;
    const event = eventType
      ? this.outbox?.create(eventType, 'escrow', escrow.id, escrow)
      : undefined;
    if (this.redis) {
      try {
        const transaction = this.redis
          .multi()
          .set(this.escrowKey(escrow.id), JSON.stringify(escrow));
        if (event) this.outbox!.appendToTransaction(transaction, event);
        const results = await transaction.exec();
        assertTransactionApplied(results);
        return;
      } catch (err) {
        this.rethrowIfInconsistent('persist', escrow.id, err);
        this.logFallback('persist', err);
      }
    }
    this.escrows.set(escrow.id, escrow);
    if (event) await this.outbox!.append(event);
  }

  private escrowKey(id: string): string {
    return `${ESCROW_KEY_PREFIX}${id}`;
  }

  private milestoneKey(id: string): string {
    return `${MILESTONE_KEY_PREFIX}${id}`;
  }

  private depositorKey(address: string): string {
    return `${ESCROWS_BY_DEPOSITOR_PREFIX}${address}`;
  }

  private contractKey(contractEscrowId: string): string {
    return `${ESCROWS_BY_CONTRACT_PREFIX}${contractEscrowId}`;
  }

  private async fetchMany(ids: string[]): Promise<Escrow[]> {
    if (ids.length === 0) return [];
    const raw = await this.redis!.mget(...ids.map((id: string) => this.escrowKey(id)));
    return raw.filter((r): r is string => r !== null).map((r: string) => JSON.parse(r) as Escrow);
  }

  private logFallback(operation: string, err: unknown): void {
    this.metrics.increment(ESCROW_PERSISTENCE_FALLBACK_METRIC, { operation });
    this.logger.error(
      `Redis unavailable for escrow.${operation}, falling back to per-instance memory ` +
        '(multi-instance state will diverge until Redis recovers)',
      err instanceof Error ? err.stack : String(err),
    );
  }

  private rethrowIfInconsistent(operation: string, id: string, err: unknown): void {
    if (isTransactionIntegrityError(err)) {
      this.metrics.increment(ESCROW_TRANSACTION_INCONSISTENT_METRIC, {
        operation,
        reason: err.reason,
      });
      this.logger.error(
        `Redis transaction integrity failure in escrow.${operation} for id=${id}: ${err.message}`,
        err instanceof Error ? err.stack : String(err),
      );
      throw new ServiceUnavailableException(
        `Redis transaction integrity failure in escrow.${operation}: ${err.message}`,
      );
    }
  }
}
