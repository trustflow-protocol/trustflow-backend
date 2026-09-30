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
import { config } from '../config/env.config';

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

export interface Escrow {
  id: string;
  depositor: string;
  beneficiary: string;
  amountXLM: string;
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

const ESCROW_KEY_PREFIX = 'escrow:';
const ESCROWS_INDEX_KEY = 'escrows:index';
const ESCROWS_BY_DEPOSITOR_PREFIX = 'escrows:by-depositor:';
const ESCROWS_BY_CONTRACT_PREFIX = 'escrows:by-contract:';

/** Emitted (see `GET /metrics`) every time a call falls back to the in-memory store. */
export const ESCROW_PERSISTENCE_FALLBACK_METRIC = 'escrow_persistence_fallback_total';

/**
 * Counts writes that were refused because a `MULTI`/`EXEC` did not apply as a unit. A
 * non-zero rate means Redis state may need reconciling — it is an alerting signal, not a
 * transient blip.
 */
export const ESCROW_TRANSACTION_INCONSISTENT_METRIC = 'escrow_transaction_inconsistent_total';

import { AuditService } from '../audit/audit.service';

/**
 * Escrow store. Backed by Redis so escrow state survives restarts and is shared across
 * instances behind a load balancer — see PERSISTENT_STORAGE_SPIKE.md §2 and its "Follow-up
 * decisions" addendum for the full write-up and the money-adjacent/audit-sensitive trade-off
 * this store's persistence layer was deliberately left open pending (#187).
 *
 * Decision: Redis, not a relational store. A relational store would give ACID multi-row
 * transactions, point-in-time recovery, and SQL-based audit querying "for free," but this
 * backend has no DB driver, ORM, or connection pool configured anywhere today — adopting one
 * is new infrastructure, not a drop-in swap, and nothing in this service's access patterns
 * (point lookups by id/contractEscrowId, filter by depositor) needs cross-entity joins or
 * multi-row transactions that would justify that lift on its own. Redis is already a hard
 * dependency here and gives every access pattern this service needs via strings/sets/sorted
 * sets, following the exact pattern `NonceStoreService`/`GigService` already establish.
 * Durability (AOF/backup configuration) for treating Redis as ground truth for money-adjacent
 * state remains an infra question for whoever owns the deployment (spike §7) — not something
 * this migration itself can verify — so the in-memory fallback here is refused outright in
 * production (see `onModuleInit`) rather than silently engaged, exactly like `GigService`.
 *
 * Falls back to a process-local Map when Redis is unavailable, logged at `error` level and
 * counted via `ESCROW_PERSISTENCE_FALLBACK_METRIC`.
 */
@Injectable()
export class EscrowService implements OnModuleInit {
  private readonly logger = new SanitizedLogger(EscrowService.name);

  /** Fallback store, only used while Redis is unavailable. */
  private escrows: Map<string, Escrow> = new Map();

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

  async create(depositor: string, beneficiary: string, amountXLM: string): Promise<Escrow> {
    const id = randomUUID();
    this.warnIfSelfDealing(depositor, beneficiary, id);
    const escrow: Escrow = {
      id,
      depositor,
      beneficiary,
      amountXLM,
      status: 'pending',
      createdAt: new Date().toISOString(),
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
   * Overwrites status/amount directly from chain-verified state. This bypasses the
   * transition guards in release()/raiseDispute() by design — it exists for the
   * reconciler to correct DB drift once the chain is already known to be ahead,
   * not for driving ordinary business-flow transitions.
   */
  /**
   * Applies chain-verified state updates with optimistic locking to prevent concurrent
   * updates from causing double-deduction during reconciliation. The version field acts
   * as an idempotency marker: if the escrow was modified between reading chain state and
   * applying the patch, the write is rejected and the caller can retry with fresh data.
   */
  async applyChainState(id: string, patch: ChainStatePatch, expectedVersion?: number): Promise<Escrow> {
    const escrow = await this.findById(id);
    if (!escrow) throw new NotFoundException('Escrow not found');
    
    // Optimistic lock check: if caller provides expected version, ensure it matches
    if (expectedVersion !== undefined && escrow.version !== expectedVersion) {
      throw new ConflictException(
        `Escrow version mismatch: expected ${expectedVersion}, found ${escrow.version}. ` +
        'The escrow was modified concurrently; retry reconciliation with fresh chain state.'
      );
    }
    
    if (patch.status !== undefined) {
      if (!ESCROW_STATUSES.includes(patch.status)) {
        throw new BadRequestException(`Invalid escrow status: ${String(patch.status)}`);
      }
      escrow.status = patch.status;
    }
    if (patch.amountXLM !== undefined) escrow.amountXLM = patch.amountXLM;
    
    // Version is auto-incremented by persist()
    await this.persist(escrow);
    return escrow;
  }

  /**
   * Overwrites status (and optionally the manual-review flag) directly, bypassing the normal
   * transition guards — used by dispute-saga compensating actions to correct an escrow after a
   * step fails partway through, the same kind of direct, guard-bypassing write
   * `applyChainState` does for the reconciler.
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

  /** Creates a DB row for an escrow found on-chain but never recorded (e.g. a missed creation event). */
  async createFromChainState(seed: ChainEscrowSeed): Promise<Escrow> {
    const id = randomUUID();
    this.warnIfSelfDealing(seed.depositor, seed.beneficiary, id);
    const escrow: Escrow = {
      id,
      depositor: seed.depositor,
      beneficiary: seed.beneficiary,
      amountXLM: seed.amountXLM,
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

  async release(id: string, user: string = 'system'): Promise<Escrow> {
    const escrow = await this.findById(id);
    if (!escrow) throw new NotFoundException('Escrow not found');
    if (escrow.status === 'released') throw new ConflictException('Escrow is already released');
    if (escrow.status !== 'disputed')
      throw new BadRequestException('Only disputed escrows can be released');

    const beforeState = { ...escrow };
    escrow.status = 'released';
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
        .catch(err => this.logger.error('Failed to write audit log', err));
    }

    return escrow;
  }

  async cancel(id: string): Promise<Escrow> {
    const escrow = await this.findById(id);
    if (!escrow) throw new NotFoundException('Escrow not found');
    if (escrow.status === 'cancelled') throw new ConflictException('Escrow is already cancelled');
    if (escrow.status !== 'disputed')
      throw new BadRequestException('Only disputed escrows can be cancelled');
    escrow.status = 'cancelled';
    await this.persist(escrow, ESCROW_EVENTS.ESCROW_CANCELLED);
    return escrow;
  }

  async split(id: string, splitPercentage: number): Promise<Escrow> {
    const escrow = await this.findById(id);
    if (!escrow) throw new NotFoundException('Escrow not found');
    if (escrow.status === 'released') throw new ConflictException('Escrow is already released');
    if (escrow.status !== 'disputed')
      throw new BadRequestException('Only disputed escrows can be split');
    escrow.status = 'released';
    escrow.splitPercentage = splitPercentage;
    await this.persist(escrow, ESCROW_EVENTS.ESCROW_SPLIT);
    return escrow;
  }

  async raiseDispute(id: string, reason?: string, user: string = 'system'): Promise<Escrow> {
    const escrow = await this.findById(id);
    if (!escrow) throw new NotFoundException('Escrow not found');
    if (escrow.status === 'released')
      throw new BadRequestException('Cannot dispute a released escrow');
    if (escrow.status === 'disputed') throw new ConflictException('Escrow is already disputed');
    // Only an active (funded, unreleased) escrow can start a new dispute — the
    // same rule the contract's raise_dispute enforces (#633).
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
        .catch(err => this.logger.error('Failed to write audit log', err));
    }

    return escrow;
  }

  /** Writes an escrow's current field values without touching any index (its id/depositor never change). */
  private async persist(escrow: Escrow, eventType?: string): Promise<void> {
    // Auto-increment version for optimistic locking on every write
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

  private async fetchMany(ids: string[]): Promise<Escrow[]> {
    if (ids.length === 0) return [];
    const raw = await this.redis!.mget(...ids.map(id => this.escrowKey(id)));
    return raw.filter((r): r is string => r !== null).map(r => JSON.parse(r) as Escrow);
  }

  private escrowKey(id: string): string {
    return `${ESCROW_KEY_PREFIX}${id}`;
  }

  private depositorKey(address: string): string {
    return `${ESCROWS_BY_DEPOSITOR_PREFIX}${address}`;
  }

  private contractKey(contractEscrowId: string): string {
    return `${ESCROWS_BY_CONTRACT_PREFIX}${contractEscrowId}`;
  }

  /**
   * Surfaces a transaction-integrity failure instead of absorbing it.
   *
   * This is the fix for the "gig created but escrow failed" class of bug. `MULTI`/`EXEC` does
   * not roll back the commands that already ran, so when one queued command fails the earlier
   * writes in the same batch are still durable in Redis. The previous code caught that signal
   * — it exists precisely to be thrown — logged it, then wrote the entity to a process-local
   * Map and returned success. The caller got a 2xx for a write that was half applied, and the
   * in-memory copy diverged from Redis.
   *
   * Degrading is only safe for a genuine connectivity failure, where *nothing* was applied.
   * So that case still falls through to `logFallback`, while an integrity failure is reported
   * to the caller as 503 — retryable, and never a false success.
   */
  private rethrowIfInconsistent(operation: string, escrowId: string, err: unknown): void {
    if (!isTransactionIntegrityError(err)) return;

    const transactionError = err;
    this.metrics.increment(ESCROW_TRANSACTION_INCONSISTENT_METRIC, {
      operation,
      reason: transactionError.reason,
    });
    this.logger.error(
      `Escrow transaction for ${operation} (${escrowId}) did not apply as a unit ` +
        `(${transactionError.reason}). Redis does not roll back a partially applied MULTI, ` +
        'so the stored state may be incomplete and the in-memory fallback is unsafe. ' +
        'Refusing to report success.',
      transactionError.stack,
    );

    throw new ServiceUnavailableException(
      `Escrow ${operation} could not be committed atomically — please retry`,
    );
  }

  private logFallback(operation: string, err: unknown): void {
    this.metrics.increment(ESCROW_PERSISTENCE_FALLBACK_METRIC, { operation });
    this.logger.error(
      `Redis unavailable for escrow.${operation}, falling back to per-instance memory ` +
        '(multi-instance state will diverge until Redis recovers)',
      err instanceof Error ? err.stack : String(err),
    );
  }
}
