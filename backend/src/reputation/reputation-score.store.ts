import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { MetricsService } from '../monitoring/metrics.service';
import { ReputationScoreRecord } from './reputation.types';

const SCORE_KEY_PREFIX = 'reputation:score:';
const SCORES_INDEX_KEY = 'reputation:scores:index';

/** Emitted (see `GET /metrics`) every time a call falls back to the in-memory store. */
export const REPUTATION_PERSISTENCE_FALLBACK_METRIC = 'reputation_persistence_fallback_total';

/**
 * Materialized reputation-score store. Backed by Redis so scores survive restarts and are
 * shared across instances — see PERSISTENT_STORAGE_SPIKE.md and its "Follow-up decisions"
 * addendum (#190). Simple KV shape (point lookup by address, full scan for the leaderboard),
 * the lowest-risk store in that follow-up's inventory.
 *
 * Falls back to a process-local Map when Redis is unavailable, logged at `error` level and
 * counted via `REPUTATION_PERSISTENCE_FALLBACK_METRIC`.
 */
@Injectable()
export class ReputationScoreStore implements OnModuleInit {
  private readonly logger = new Logger(ReputationScoreStore.name);
  /** Fallback store, only used while Redis is unavailable. */
  private readonly records: Map<string, ReputationScoreRecord> = new Map();

  constructor(
    @Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null = null,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  onModuleInit(): void {
    if (!this.redis && process.env.NODE_ENV === 'production') {
      throw new Error(
        'ReputationScoreStore requires REDIS_URL to be configured in production — refusing to ' +
          'start with per-instance in-memory storage, which would silently diverge across instances.',
      );
    }
  }

  async get(address: string): Promise<ReputationScoreRecord | undefined> {
    if (this.redis) {
      try {
        const raw = await this.redis.get(this.key(address));
        return raw ? (JSON.parse(raw) as ReputationScoreRecord) : undefined;
      } catch (err) {
        this.logFallback('get', err);
      }
    }

    return this.records.get(address);
  }

  async save(record: ReputationScoreRecord): Promise<void> {
    if (this.redis) {
      try {
        const results = await this.redis
          .multi()
          .set(this.key(record.address), JSON.stringify(record))
          .sadd(SCORES_INDEX_KEY, record.address)
          .exec();
        this.assertTransactionOk(results);
        return;
      } catch (err) {
        this.logFallback('save', err);
      }
    }

    this.records.set(record.address, record);
  }

  async findAll(): Promise<ReputationScoreRecord[]> {
    if (this.redis) {
      try {
        const addresses = await this.redis.smembers(SCORES_INDEX_KEY);
        if (addresses.length === 0) return [];
        const raw = await this.redis.mget(...addresses.map(a => this.key(a)));
        return raw
          .filter((r): r is string => r !== null)
          .map(r => JSON.parse(r) as ReputationScoreRecord);
      } catch (err) {
        this.logFallback('findAll', err);
      }
    }

    return [...this.records.values()];
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

  private key(address: string): string {
    return `${SCORE_KEY_PREFIX}${address}`;
  }

  private logFallback(operation: string, err: unknown): void {
    this.metrics?.increment(REPUTATION_PERSISTENCE_FALLBACK_METRIC, { operation });
    this.logger.error(
      `Redis unavailable for reputationScore.${operation}, falling back to per-instance memory ` +
        '(multi-instance state will diverge until Redis recovers)',
      err instanceof Error ? err.stack : String(err),
    );
  }
}
