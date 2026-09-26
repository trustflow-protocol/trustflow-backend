import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { MetricsService } from '../monitoring/metrics.service';
import { ReconciliationRun } from './escrow-reconciliation.types';
import { config } from '../config/env.config';

const RUN_KEY_PREFIX = 'escrow-reconciliation:run:';
const RUNS_INDEX_KEY = 'escrow-reconciliation:runs:index';

/** Emitted (see `GET /metrics`) every time a call falls back to the in-memory store. */
export const ESCROW_RECONCILIATION_PERSISTENCE_FALLBACK_METRIC =
  'escrow_reconciliation_persistence_fallback_total';

/**
 * Reconciliation run-history store. Backed by Redis so run history survives restarts and is
 * shared across instances — see PERSISTENT_STORAGE_SPIKE.md and its "Follow-up decisions"
 * addendum (#190). Simple KV shape (point lookup by runId, sorted-by-time listing).
 *
 * Falls back to a process-local Map when Redis is unavailable, logged at `error` level and
 * counted via `ESCROW_RECONCILIATION_PERSISTENCE_FALLBACK_METRIC`.
 */
@Injectable()
export class EscrowReconciliationStateStore implements OnModuleInit {
  private readonly logger = new Logger(EscrowReconciliationStateStore.name);
  /** Fallback store, only used while Redis is unavailable. */
  private readonly runs: Map<string, ReconciliationRun> = new Map();

  constructor(
    @Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null = null,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  onModuleInit(): void {
    if (!this.redis && config.NODE_ENV === 'production') {
      throw new Error(
        'EscrowReconciliationStateStore requires REDIS_URL to be configured in production — ' +
          'refusing to start with per-instance in-memory storage, which would silently diverge ' +
          'across instances.',
      );
    }
  }

  async save(run: ReconciliationRun): Promise<void> {
    if (this.redis) {
      try {
        const results = await this.redis
          .multi()
          .set(this.key(run.runId), JSON.stringify(run))
          .zadd(RUNS_INDEX_KEY, Date.parse(run.startedAt), run.runId)
          .exec();
        this.assertTransactionOk(results);
        return;
      } catch (err) {
        this.logFallback('save', err);
      }
    }

    this.runs.set(run.runId, run);
  }

  async findById(runId: string): Promise<ReconciliationRun | undefined> {
    if (this.redis) {
      try {
        const raw = await this.redis.get(this.key(runId));
        return raw ? (JSON.parse(raw) as ReconciliationRun) : undefined;
      } catch (err) {
        this.logFallback('findById', err);
      }
    }

    return this.runs.get(runId);
  }

  async findAll(): Promise<ReconciliationRun[]> {
    if (this.redis) {
      try {
        const ids = await this.redis.zrange(RUNS_INDEX_KEY, 0, -1);
        if (ids.length === 0) return [];
        const raw = await this.redis.mget(...ids.map(id => this.key(id)));
        const runs = raw
          .filter((r): r is string => r !== null)
          .map(r => JSON.parse(r) as ReconciliationRun);
        return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      } catch (err) {
        this.logFallback('findAll', err);
      }
    }

    return [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
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

  private key(runId: string): string {
    return `${RUN_KEY_PREFIX}${runId}`;
  }

  private logFallback(operation: string, err: unknown): void {
    this.metrics?.increment(ESCROW_RECONCILIATION_PERSISTENCE_FALLBACK_METRIC, { operation });
    this.logger.error(
      `Redis unavailable for escrowReconciliationState.${operation}, falling back to ` +
        'per-instance memory (multi-instance state will diverge until Redis recovers)',
      err instanceof Error ? err.stack : String(err),
    );
  }
}
