import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { GigService } from './gig.service';
import { DEFAULT_GIG_EXPIRY_SWEEP_INTERVAL_MS } from './gig.entity';

/**
 * Periodically sweeps the DB for open gig solicitations whose response deadline has
 * passed and marks them expired. GigService appends the corresponding durable
 * outbox row in the same state transaction; the outbox relay notifies subscribers.
 * guarantees stale solicitations don't sit open forever waiting for a response that
 * will never come.
 *
 * Interval is configurable via GIG_EXPIRY_SWEEP_INTERVAL_MS (milliseconds); set to 0 or
 * a negative value to disable the background sweep entirely (e.g. in tests).
 */
@Injectable()
export class GigExpiryWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GigExpiryWorkerService.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly gigService: GigService) {}

  onModuleInit(): void {
    const intervalMs = this.getIntervalMs();
    if (intervalMs <= 0) {
      this.logger.log('Gig expiry sweep disabled (GIG_EXPIRY_SWEEP_INTERVAL_MS <= 0)');
      return;
    }

    this.timer = setInterval(() => {
      this.runOnce().catch(error => this.logger.error('Gig expiry sweep failed', error));
    }, intervalMs);
    this.timer.unref?.();

    this.logger.log(`Gig expiry worker started — sweeping every ${intervalMs}ms`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
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
