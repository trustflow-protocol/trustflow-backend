import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { GigService } from './gig.service';
import { DEFAULT_GIG_EXPIRY_SWEEP_INTERVAL_MS } from './gig.entity';
import { DistributedLockService } from '../common/redis/distributed-lock.service';

const LOCK_KEY = 'lock:gig-expiry-sweep';

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
    const token = await this.lock.tryAcquire(LOCK_KEY, Math.ceil(intervalMs * 1.5));
    if (!token) {
      return; // another instance is holding the lock for this tick
    }
    this.currentLockToken = token;
    try {
      await this.runOnce();
    } finally {
      await this.lock.release(LOCK_KEY, token);
      this.currentLockToken = undefined;
    }
  }

  /** Runs a single sweep. Exposed so it can also be triggered manually (e.g. from tests or an admin endpoint). */
  async runOnce(): Promise<void> {
    const expirable = await this.gigService.findExpirable();

    for (const gig of expirable) {
      const expired = await this.gigService.expire(gig.id);
      if (!expired) continue;
    }
  }

  private getIntervalMs(): number {
    const raw = Number(process.env.GIG_EXPIRY_SWEEP_INTERVAL_MS);
    return Number.isFinite(raw) && process.env.GIG_EXPIRY_SWEEP_INTERVAL_MS !== undefined
      ? raw
      : DEFAULT_GIG_EXPIRY_SWEEP_INTERVAL_MS;
  }
}
