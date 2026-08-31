import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { GigService } from './gig.service';
import { DEFAULT_GIG_EXPIRY_SWEEP_INTERVAL_MS } from './gig.entity';
import { DistributedLockService } from '../common/redis/distributed-lock.service';
import { mapWithConcurrency, countRejected } from '../common/concurrency';

const LOCK_KEY = 'lock:gig-expiry-sweep';
/** How many gigs to expire in parallel within one sweep (#236). */
const SWEEP_CONCURRENCY = Number(process.env.GIG_EXPIRY_SWEEP_CONCURRENCY) || 8;

/**
 * Periodically sweeps the DB for open gig solicitations whose response deadline has
 * passed and marks them expired. GigService appends the corresponding durable
 * outbox row in the same state transaction; the outbox relay notifies subscribers.
 * guarantees stale solicitations don't sit open forever waiting for a response that
 * will never come.
 *
 * Interval is configurable via GIG_EXPIRY_SWEEP_INTERVAL_MS (milliseconds); set to 0 or
 * a negative value to disable the background sweep entirely (e.g. in tests).
 *
 * Runs behind a Redis distributed lock (see `DistributedLockService`) so only one
 * instance's tick actually executes `runOnce()` when multiple instances are
 * deployed. Each tick acquires a fresh lock with a TTL of 1.5x the sweep interval —
 * long enough to comfortably outlive one tick's own runtime, short enough that if
 * the holder crashes mid-lease, another instance picks the sweep back up within
 * about two intervals once the lease expires, with no separate renewal heartbeat
 * needed. The lock is also released explicitly on graceful shutdown.
 */
@Injectable()
export class GigExpiryWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GigExpiryWorkerService.name);
  private timer?: NodeJS.Timeout;
  private currentLockToken?: string;
  /** Guards against a slow sweep still running when the next tick fires (#236). */
  private sweeping = false;

  constructor(
    private readonly gigService: GigService,
    private readonly lock: DistributedLockService,
  ) {}

  onModuleInit(): void {
    const intervalMs = this.getIntervalMs();
    if (intervalMs <= 0) {
      this.logger.log('Gig expiry sweep disabled (GIG_EXPIRY_SWEEP_INTERVAL_MS <= 0)');
      return;
    }

    this.timer = setInterval(() => {
      this.tick(intervalMs).catch(error => this.logger.error('Gig expiry sweep failed', error));
    }, intervalMs);
    this.timer.unref?.();

    this.logger.log(`Gig expiry worker started — sweeping every ${intervalMs}ms`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.currentLockToken) {
      await this.lock.release(LOCK_KEY, this.currentLockToken);
      this.currentLockToken = undefined;
    }
  }

  private async tick(intervalMs: number): Promise<void> {
    if (this.sweeping) {
      this.logger.warn('Previous gig expiry sweep still in flight — skipping this tick');
      return;
    }
    const token = await this.lock.tryAcquire(LOCK_KEY, Math.ceil(intervalMs * 1.5));
    if (!token) {
      return; // another instance is holding the lock for this tick
    }
    this.currentLockToken = token;
    this.sweeping = true;
    try {
      await this.runOnce();
    } finally {
      this.sweeping = false;
      await this.lock.release(LOCK_KEY, token);
      this.currentLockToken = undefined;
    }
  }

  /** Runs a single sweep. Exposed so it can also be triggered manually (e.g. from tests or an admin endpoint). */
  async runOnce(): Promise<void> {
    const expirable = await this.gigService.findExpirable();

    // Expire gigs with bounded concurrency instead of one-at-a-time: each
    // `expire()` appends an outbox row the relay then delivers with retries,
    // so a fully sequential loop over a big batch serialised all of that
    // latency and could outrun the sweep interval (#236). A failed `expire`
    // no longer aborts the rest of the sweep — it is counted and logged.
    const results = await mapWithConcurrency(expirable, SWEEP_CONCURRENCY, gig =>
      this.gigService.expire(gig.id),
    );
    const failed = countRejected(results);
    if (failed > 0) {
      this.logger.warn(`Gig expiry sweep: ${failed}/${expirable.length} gigs failed to expire`);
    }
  }

  private getIntervalMs(): number {
    const raw = Number(process.env.GIG_EXPIRY_SWEEP_INTERVAL_MS);
    return Number.isFinite(raw) && process.env.GIG_EXPIRY_SWEEP_INTERVAL_MS !== undefined
      ? raw
      : DEFAULT_GIG_EXPIRY_SWEEP_INTERVAL_MS;
  }
}
