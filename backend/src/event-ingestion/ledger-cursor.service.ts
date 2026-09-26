import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { MetricsService } from '../monitoring/metrics.service';
import { config } from '../config/env.config';

export interface LedgerCheckpoint {
  ledgerSequence: number;
  lastProcessedLedger: number;
  cursorPosition: string;
  updatedAt: Date;
  networkHash: string;
}

const CURSOR_KEY_PREFIX = 'ledger_cursor:';

/** Emitted (see `GET /metrics`) every time a call falls back to the in-memory store. */
export const LEDGER_CURSOR_PERSISTENCE_FALLBACK_METRIC = 'ledger_cursor_persistence_fallback_total';

/**
 * Per-contract ledger ingestion cursor. Backed by Redis so the cursor survives restarts and is
 * shared across instances — see PERSISTENT_STORAGE_SPIKE.md and its "Follow-up decisions"
 * addendum (#190). Already keyed with a `ledger_cursor:` prefix before this migration — it was
 * already shaped like a Redis key, i.e. this was an unfinished migration.
 *
 * `EventProcessorService`/`LedgerCursorService`'s reorg-safety semantics — a lost or stale
 * cursor risks re-processing (idempotent, see EventProcessorService's dedup log) or skipping
 * ledgers — are unaffected by this migration: a value round-tripped through Redis is byte-for-
 * byte the same value that used to live in the Map, just durable and shared now instead of
 * per-instance and volatile.
 *
 * Falls back to a process-local Map when Redis is unavailable, logged at `error` level and
 * counted via `LEDGER_CURSOR_PERSISTENCE_FALLBACK_METRIC`.
 */
@Injectable()
export class LedgerCursorService implements OnModuleInit {
  private readonly logger = new Logger(LedgerCursorService.name);
  /** Fallback store, only used while Redis is unavailable. */
  private checkpoints: Map<string, LedgerCheckpoint> = new Map();

  constructor(
    @Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null = null,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  onModuleInit(): void {
    if (!this.redis && config.NODE_ENV === 'production') {
      throw new Error(
        'LedgerCursorService requires REDIS_URL to be configured in production — refusing to ' +
          'start with per-instance in-memory storage, which would silently diverge across instances.',
      );
    }
  }

  async getCursor(contractId: string): Promise<LedgerCheckpoint | undefined> {
    const key = this.cursorKey(contractId);
    if (this.redis) {
      try {
        const raw = await this.redis.get(key);
        if (!raw) return undefined;
        const parsed = JSON.parse(raw) as LedgerCheckpoint;
        return { ...parsed, updatedAt: new Date(parsed.updatedAt) };
      } catch (err) {
        this.logFallback('getCursor', err);
      }
    }

    return this.checkpoints.get(key);
  }

  async updateCursor(
    contractId: string,
    ledgerSequence: number,
    cursorPosition: string,
    networkHash: string,
  ): Promise<void> {
    const key = this.cursorKey(contractId);
    const checkpoint: LedgerCheckpoint = {
      ledgerSequence,
      lastProcessedLedger: ledgerSequence,
      cursorPosition,
      updatedAt: new Date(),
      networkHash,
    };

    if (this.redis) {
      try {
        await this.redis.set(key, JSON.stringify(checkpoint));
        this.logger.log(`Cursor updated for contract ${contractId}: ledger ${ledgerSequence}`);
        return;
      } catch (err) {
        this.logFallback('updateCursor', err);
      }
    }

    this.checkpoints.set(key, checkpoint);
    this.logger.log(`Cursor updated for contract ${contractId}: ledger ${ledgerSequence}`);
  }

  async resetCursor(contractId: string): Promise<void> {
    const key = this.cursorKey(contractId);
    if (this.redis) {
      try {
        await this.redis.del(key);
        this.logger.log(`Cursor reset for contract ${contractId}`);
        return;
      } catch (err) {
        this.logFallback('resetCursor', err);
      }
    }

    this.checkpoints.delete(key);
    this.logger.log(`Cursor reset for contract ${contractId}`);
  }

  async getStartLedger(contractId: string): Promise<number> {
    const checkpoint = await this.getCursor(contractId);
    return checkpoint ? checkpoint.lastProcessedLedger + 1 : 0;
  }

  private cursorKey(contractId: string): string {
    return `${CURSOR_KEY_PREFIX}${contractId}`;
  }

  private logFallback(operation: string, err: unknown): void {
    this.metrics?.increment(LEDGER_CURSOR_PERSISTENCE_FALLBACK_METRIC, { operation });
    this.logger.error(
      `Redis unavailable for ledgerCursor.${operation}, falling back to per-instance memory ` +
        '(multi-instance state will diverge until Redis recovers)',
      err instanceof Error ? err.stack : String(err),
    );
  }
}
