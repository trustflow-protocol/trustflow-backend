import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DistributedLockService } from '../common/redis/distributed-lock.service';
import { EscrowReconciliationService } from './escrow-reconciliation.service';
import { DEFAULT_ESCROW_RECONCILIATION_SWEEP_INTERVAL_MS } from './escrow-reconciliation.types';
import { config } from '../config/env.config';

const LOCK_KEY = 'lock:escrow-reconciliation-sweep';

/**
 * Periodically re-diffs on-chain escrow state against the DB so drift from missed
 * events or partial writes doesn't sit unnoticed between manual runs.
 *
 * Interval is configurable via ESCROW_RECONCILIATION_SWEEP_INTERVAL_MS (milliseconds);
 * set to 0 or a negative value to disable the background sweep entirely (e.g. in tests).
 */
@Injectable()
export class EscrowReconciliationWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EscrowReconciliationWorkerService.name);
  private timer?: NodeJS.Timeout;
  private currentLockToken?: string;
  private sweeping = false;

  constructor(
    private readonly reconciliationService: EscrowReconciliationService,
    private readonly lock: DistributedLockService,
  ) {}

  onModuleInit(): void {
    const intervalMs = this.getIntervalMs();
    if (intervalMs <= 0) {
      this.logger.log(
        'Escrow reconciliation sweep disabled (ESCROW_RECONCILIATION_SWEEP_INTERVAL_MS <= 0)',
      );
      return;
    }

    this.timer = setInterval(() => {
      this.runOnce().catch(error => this.logger.error('Escrow reconciliation sweep failed', error));
    }, intervalMs);
    this.timer.unref?.();

    this.logger.log(`Escrow reconciliation worker started — sweeping every ${intervalMs}ms`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.currentLockToken) {
      await this.lock.release(LOCK_KEY, this.currentLockToken);
      this.currentLockToken = undefined;
    }
  }

  /** Runs a single sweep. Exposed so it can also be triggered manually (e.g. from tests or an admin endpoint). */
  async runOnce(): Promise<void> {
    if (this.sweeping) {
      this.logger.warn('Previous escrow reconciliation sweep still in flight — skipping this tick');
      return;
    }

    this.sweeping = true;
    let token: string | null = null;
    try {
      const intervalMs = this.getIntervalMs();
      token = await this.lock.tryAcquire(LOCK_KEY, Math.ceil(Math.max(intervalMs, 1) * 1.5));
      if (!token) {
        this.logger.warn(
          'Another instance holds the escrow reconciliation lock — skipping this tick',
        );
        return;
      }

      this.currentLockToken = token;
      await this.reconciliationService.reconcile();
    } finally {
      this.sweeping = false;
      if (token) {
        await this.lock.release(LOCK_KEY, token);
        if (this.currentLockToken === token) this.currentLockToken = undefined;
      }
    }
  }

  private getIntervalMs(): number {
    return (
      config.ESCROW_RECONCILIATION_SWEEP_INTERVAL_MS ??
      DEFAULT_ESCROW_RECONCILIATION_SWEEP_INTERVAL_MS
    );
  }
}
