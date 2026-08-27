import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { MetricsService } from '../monitoring/metrics.service';
import { CreateGigDto, UpdateGigDto } from './gig.dto';
import { DEFAULT_RESPONSE_WINDOW_HOURS, GIG_EVENTS, Gig, GigStatus } from './gig.entity';
import { OutboxService } from '../outbox/outbox.service';

const GIG_KEY_PREFIX = 'gig:';
const GIGS_INDEX_KEY = 'gigs:index';
const GIGS_OPEN_BY_RESPOND_BY_KEY = 'gigs:open:respondBy';
const GIGS_BY_CREATOR_PREFIX = 'gigs:by-creator:';

/** Emitted (see `/metrics`) every time a call falls back to the in-memory store. */
export const GIG_PERSISTENCE_FALLBACK_METRIC = 'gig_persistence_fallback_total';

/**
 * Gig solicitation store. Backed by Redis so gig state survives restarts and is shared
 * across instances behind a load balancer — see PERSISTENT_STORAGE_SPIKE.md. Falls back to
 * a process-local Map when Redis is unavailable, matching the degrade-gracefully pattern
 * already used by NonceStoreService/RateLimitGuard elsewhere in this codebase. That fallback
 * reintroduces per-instance divergence for as long as it's active, so it's logged at error
 * level, counted via `GIG_PERSISTENCE_FALLBACK_METRIC`, and — in production — refused outright
 * at startup rather than silently engaged (see `onModuleInit`).
 */
@Injectable()
export class GigService implements OnModuleInit {
  private readonly logger = new Logger(GigService.name);

  /** Fallback store, only used while Redis is unavailable. */
  private readonly gigs = new Map<string, Gig>();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
    private readonly metrics: MetricsService,
    @Optional() private readonly outbox?: OutboxService,
  ) {}

  /**
   * In production, a missing Redis client means every gig write would silently start
   * diverging per-instance — exactly the failure mode this store exists to eliminate. Fail
   * app startup instead of degrading quietly. Non-production environments (dev/test) keep the
   * in-memory fallback so the app still runs without a local Redis.
   */
  onModuleInit(): void {
    if (!this.redis && process.env.NODE_ENV === 'production') {
      throw new Error(
        'GigService requires REDIS_URL to be configured in production — refusing to start ' +
          'with per-instance in-memory storage, which would silently diverge across instances.',
      );
    }
  }

  async create(dto: CreateGigDto): Promise<Gig> {
    const id = `gig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date();
    const windowHours = dto.responseWindowHours ?? DEFAULT_RESPONSE_WINDOW_HOURS;

    const gig: Gig = {
      id,
      creator: dto.creator,
      title: dto.title,
      budgetXLM: dto.budgetXLM,
      status: GigStatus.OPEN,
      createdAt: now.toISOString(),
      respondBy: new Date(now.getTime() + windowHours * 60 * 60 * 1000).toISOString(),
    };

    const event = this.outbox?.create(GIG_EVENTS.GIG_CREATED, 'gig', id, gig);

    if (this.redis) {
      try {
        const transaction = this.redis
          .multi()
          .set(this.gigKey(id), JSON.stringify(gig))
          .zadd(GIGS_INDEX_KEY, now.getTime(), id)
          .zadd(GIGS_OPEN_BY_RESPOND_BY_KEY, new Date(gig.respondBy).getTime(), id)
          .sadd(this.creatorKey(gig.creator), id);
        if (event) this.outbox!.appendToTransaction(transaction, event);
        const results = await transaction.exec();
        this.assertTransactionOk(results);
        return gig;
      } catch (err) {
        this.logFallback('create', err);
      }
    }

    this.gigs.set(id, gig);
    if (event) await this.outbox!.append(event);
    return gig;
  }

  async findAll(): Promise<Gig[]> {
    if (this.redis) {
      try {
        const ids = await this.redis.zrange(GIGS_INDEX_KEY, 0, -1);
        return await this.fetchMany(ids);
      } catch (err) {
        this.logFallback('findAll', err);
      }
    }

    return [...this.gigs.values()];
  }

  async findById(id: string): Promise<Gig> {
    const gig = await this.tryFindById(id);
    if (!gig) throw new NotFoundException(`Gig ${id} not found`);
    return gig;
  }

  async findByCreator(address: string): Promise<Gig[]> {
    if (this.redis) {
      try {
        const ids = await this.redis.smembers(this.creatorKey(address));
        return await this.fetchMany(ids);
      } catch (err) {
        this.logFallback('findByCreator', err);
      }
    }

    return [...this.gigs.values()].filter(g => g.creator === address);
  }

  /** Open gig solicitations whose response deadline has passed as of `now`. */
  async findExpirable(now: Date = new Date()): Promise<Gig[]> {
    if (this.redis) {
      try {
        const ids = await this.redis.zrangebyscore(GIGS_OPEN_BY_RESPOND_BY_KEY, 0, now.getTime());
        const gigs = await this.fetchMany(ids);
        return gigs.filter(g => g.status === GigStatus.OPEN);
      } catch (err) {
        this.logFallback('findExpirable', err);
      }
    }

    return [...this.gigs.values()].filter(
      g => g.status === GigStatus.OPEN && new Date(g.respondBy) <= now,
    );
  }

  async accept(id: string, responder: string): Promise<Gig> {
    const gig = await this.findById(id);
    if (gig.status !== GigStatus.OPEN) {
      throw new BadRequestException(`Cannot accept a gig with status "${gig.status}"`);
    }
    gig.status = GigStatus.ACCEPTED;
    gig.acceptedBy = responder;
    gig.acceptedAt = new Date().toISOString();
    await this.persistResolved(gig, GIG_EVENTS.GIG_ACCEPTED);
    return gig;
  }

  async cancel(id: string): Promise<Gig> {
    const gig = await this.findById(id);
    if (gig.status !== GigStatus.OPEN) {
      throw new BadRequestException(`Cannot cancel a gig with status "${gig.status}"`);
    }
    gig.status = GigStatus.CANCELLED;
    gig.cancelledAt = new Date().toISOString();
    await this.persistResolved(gig, GIG_EVENTS.GIG_CANCELLED);
    return gig;
  }

  async update(id: string, dto: UpdateGigDto): Promise<Gig> {
    const gig = await this.findById(id);
    if (gig.status !== GigStatus.OPEN) {
      throw new BadRequestException(`Cannot update a gig with status "${gig.status}"`);
    }
    if (dto.title !== undefined) gig.title = dto.title;
    if (dto.budgetXLM !== undefined) gig.budgetXLM = dto.budgetXLM;
    await this.persistGig(gig);
    return gig;
  }

  async remove(id: string): Promise<void> {
    const gig = await this.findById(id);
    if (gig.status === GigStatus.ACCEPTED) {
      throw new BadRequestException('Cannot delete an accepted gig');
    }
    if (this.redis) {
      try {
        await this.redis
          .multi()
          .del(this.gigKey(id))
          .zrem(GIGS_INDEX_KEY, id)
          .zrem(GIGS_OPEN_BY_RESPOND_BY_KEY, id)
          .srem(this.creatorKey(gig.creator), id)
          .exec();
        return;
      } catch (err) {
        this.logFallback('remove', err);
      }
    }
    this.gigs.delete(id);
  }

  /**
   * Marks a still-open gig as expired. Returns `undefined` (no-op) if it was already
   * resolved by the time the sweep reached it. Used by the expiry sweep worker.
   */
  async expire(id: string): Promise<Gig | undefined> {
    const gig = await this.tryFindById(id);
    if (!gig || gig.status !== GigStatus.OPEN) return undefined;
    gig.status = GigStatus.EXPIRED;
    gig.expiredAt = new Date().toISOString();
    await this.persistResolved(gig, GIG_EVENTS.GIG_EXPIRED);
    return gig;
  }

  /** Writes a gig that just left OPEN status, dropping it from the open-expiry index. */
  private async persistResolved(gig: Gig, eventType: string): Promise<void> {
    const event = this.outbox?.create(eventType, 'gig', gig.id, gig);
    if (this.redis) {
      try {
        const transaction = this.redis
          .multi()
          .set(this.gigKey(gig.id), JSON.stringify(gig))
          .zrem(GIGS_OPEN_BY_RESPOND_BY_KEY, gig.id);
        if (event) this.outbox!.appendToTransaction(transaction, event);
        const results = await transaction.exec();
        this.assertTransactionOk(results);
        return;
      } catch (err) {
        this.logFallback('persistResolved', err);
      }
    }

    this.gigs.set(gig.id, gig);
    if (event) await this.outbox!.append(event);
  }

  /** Writes a gig while keeping it in the open-expiry index if still open. */
  private async persistGig(gig: Gig): Promise<void> {
    if (this.redis) {
      try {
        const results = await this.redis
          .multi()
          .set(this.gigKey(gig.id), JSON.stringify(gig))
          .exec();
        this.assertTransactionOk(results);
        return;
      } catch (err) {
        this.logFallback('persistGig', err);
      }
    }
    this.gigs.set(gig.id, gig);
  }

  private async tryFindById(id: string): Promise<Gig | undefined> {
    if (this.redis) {
      try {
        const raw = await this.redis.get(this.gigKey(id));
        return raw ? (JSON.parse(raw) as Gig) : undefined;
      } catch (err) {
        this.logFallback('findById', err);
      }
    }

    return this.gigs.get(id);
  }

  private async fetchMany(ids: string[]): Promise<Gig[]> {
    if (ids.length === 0) return [];
    const raw = await this.redis!.mget(...ids.map(id => this.gigKey(id)));
    return raw.filter((r): r is string => r !== null).map(r => JSON.parse(r) as Gig);
  }

  /**
   * `MULTI`/`EXEC` only rejects the whole batch on a queue-time error (e.g. a malformed
   * command); a runtime failure in one queued command instead surfaces as a per-command
   * `[Error, null]` entry in the results array while `exec()` itself still resolves. Without
   * this check a partially-applied transaction (e.g. the entity written but an index update
   * silently dropped) would be treated as a full success.
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

  private gigKey(id: string): string {
    return `${GIG_KEY_PREFIX}${id}`;
  }

  private creatorKey(address: string): string {
    return `${GIGS_BY_CREATOR_PREFIX}${address}`;
  }

  private logFallback(operation: string, err: unknown): void {
    this.metrics.increment(GIG_PERSISTENCE_FALLBACK_METRIC, { operation });
    this.logger.error(
      `Redis unavailable for gig.${operation}, falling back to per-instance memory ` +
        '(multi-instance state will diverge until Redis recovers)',
      err instanceof Error ? err.stack : String(err),
    );
  }
}
