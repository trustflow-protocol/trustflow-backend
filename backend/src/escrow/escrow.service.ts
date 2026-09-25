import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { MetricsService } from '../monitoring/metrics.service';

export type EscrowStatus = 'pending' | 'active' | 'released' | 'disputed' | 'cancelled';

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
}

const ESCROW_KEY_PREFIX = 'escrow:';
const ESCROWS_INDEX_KEY = 'escrows:index';
const ESCROWS_BY_DEPOSITOR_PREFIX = 'escrows:by-depositor:';
const ESCROWS_BY_CONTRACT_PREFIX = 'escrows:by-contract:';

/** Emitted (see `GET /metrics`) every time a call falls back to the in-memory store. */
export const ESCROW_PERSISTENCE_FALLBACK_METRIC = 'escrow_persistence_fallback_total';

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
  private readonly logger = new Logger(EscrowService.name);

  /** Fallback store, only used while Redis is unavailable. */
  private escrows: Map<string, Escrow> = new Map();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * In production, a missing Redis client means every escrow write would silently start
   * diverging per-instance — for money-adjacent state, that's exactly the failure mode this
   * store exists to eliminate. Fail app startup instead of degrading quietly. Non-production
   * environments (dev/test) keep the in-memory fallback so the app still runs without a local
   * Redis.
   */
  onModuleInit(): void {
    if (!this.redis && process.env.NODE_ENV === 'production') {
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

    if (this.redis) {
      try {
        const results = await this.redis
          .multi()
          .set(this.escrowKey(id), JSON.stringify(escrow))
          .zadd(ESCROWS_INDEX_KEY, Date.parse(escrow.createdAt), id)
          .sadd(this.depositorKey(depositor), id)
          .exec();
        this.assertTransactionOk(results);
        return escrow;
      } catch (err) {
        this.logFallback('create', err);
      }
    }

    this.escrows.set(id, escrow);
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
    if (!escrow) throw new Error('Escrow not found');
    escrow.contractEscrowId = contractEscrowId;

    if (this.redis) {
      try {
        const results = await this.redis
          .multi()
          .set(this.escrowKey(id), JSON.stringify(escrow))
          .set(this.contractKey(contractEscrowId), id)
          .exec();
        this.assertTransactionOk(results);
        return escrow;
      } catch (err) {
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
  async applyChainState(id: string, patch: ChainStatePatch): Promise<Escrow> {
    const escrow = await this.findById(id);
    if (!escrow) throw new Error('Escrow not found');
    if (patch.status !== undefined) escrow.status = patch.status;
    if (patch.amountXLM !== undefined) escrow.amountXLM = patch.amountXLM;
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
    if (!escrow) throw new Error('Escrow not found');
    if (patch.status !== undefined) escrow.status = patch.status;
    if (patch.requiresManualReview !== undefined)
      escrow.requiresManualReview = patch.requiresManualReview;
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
        this.assertTransactionOk(results);
        return escrow;
      } catch (err) {
        this.logFallback('createFromChainState', err);
      }
    }

    this.escrows.set(id, escrow);
    return escrow;
  }

  async fund(id: string): Promise<Escrow> {
    const escrow = await this.findById(id);
    if (!escrow) throw new Error('Escrow not found');
    if (escrow.status !== 'pending') {
      throw new Error(`Cannot fund escrow in status: ${escrow.status}`);
    }
    escrow.status = 'active';
    await this.persist(escrow);
    return escrow;
  }

  async release(id: string): Promise<Escrow> {
    const escrow = await this.findById(id);
    if (!escrow) throw new Error('Escrow not found');
    escrow.status = 'released';
    await this.persist(escrow);
    return escrow;
  }

  async cancel(id: string): Promise<Escrow> {
    const escrow = await this.findById(id);
    if (!escrow) throw new Error('Escrow not found');
    escrow.status = 'cancelled';
    await this.persist(escrow);
    return escrow;
  }

  async split(id: string, splitPercentage: number): Promise<Escrow> {
    const escrow = await this.findById(id);
    if (!escrow) throw new Error('Escrow not found');
    escrow.status = 'released';
    escrow.splitPercentage = splitPercentage;
    await this.persist(escrow);
    return escrow;
  }

  async raiseDispute(id: string, reason?: string): Promise<Escrow> {
    const escrow = await this.findById(id);
    if (!escrow) throw new Error('Escrow not found');
    if (escrow.status === 'released') throw new Error('Cannot dispute a released escrow');
    if (escrow.status === 'disputed') throw new Error('Escrow is already disputed');

    escrow.status = 'disputed';
    escrow.disputeReason = reason;
    escrow.disputedAt = new Date().toISOString();

    await this.persist(escrow);
    return escrow;
  }

  /** Writes an escrow's current field values without touching any index (its id/depositor never change). */
  private async persist(escrow: Escrow): Promise<void> {
    if (this.redis) {
      try {
        const results = await this.redis
          .multi()
          .set(this.escrowKey(escrow.id), JSON.stringify(escrow))
          .exec();
        this.assertTransactionOk(results);
        return;
      } catch (err) {
        this.logFallback('persist', err);
      }
    }
    this.escrows.set(escrow.id, escrow);
  }

  private async fetchMany(ids: string[]): Promise<Escrow[]> {
    if (ids.length === 0) return [];
    const raw = await this.redis!.mget(...ids.map(id => this.escrowKey(id)));
    return raw.filter((r): r is string => r !== null).map(r => JSON.parse(r) as Escrow);
  }

  /**
   * `MULTI`/`EXEC` only rejects the whole batch on a queue-time error; a runtime failure in
   * one queued command instead surfaces as a per-command `[Error, null]` entry in the results
   * array while `exec()` itself still resolves. Without this check a partially-applied
   * transaction would be treated as a full success.
   */
  private assertTransactionOk(results: Array<[Error | null, unknown]> | null): void {
    if (!results) {
      throw new Error('Redis transaction aborted (exec() returned null, e.g. a WATCH conflict)');
    }
    const failed = results.find(([err]) => err);
    if (failed) {
      throw new Error(`Redis transaction command failed: ${failed[0]!.message}`);
    }
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

  private logFallback(operation: string, err: unknown): void {
    this.metrics.increment(ESCROW_PERSISTENCE_FALLBACK_METRIC, { operation });
    this.logger.error(
      `Redis unavailable for escrow.${operation}, falling back to per-instance memory ` +
        '(multi-instance state will diverge until Redis recovers)',
      err instanceof Error ? err.stack : String(err),
    );
  }
}
