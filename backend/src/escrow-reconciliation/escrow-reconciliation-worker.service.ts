import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EscrowReconciliationService } from './escrow-reconciliation.service';
import { DEFAULT_ESCROW_RECONCILIATION_SWEEP_INTERVAL_MS } from './escrow-reconciliation.types';

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

  constructor(private readonly reconciliationService: EscrowReconciliationService) {}

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

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Runs a single sweep. Exposed so it can also be triggered manually (e.g. from tests or an admin endpoint). */
  async runOnce(): Promise<void> {
    await this.reconciliationService.reconcile();
  }

  private getIntervalMs(): number {
    const raw = Number(process.env.ESCROW_RECONCILIATION_SWEEP_INTERVAL_MS);
    return Number.isFinite(raw) && process.env.ESCROW_RECONCILIATION_SWEEP_INTERVAL_MS !== undefined
      ? raw
      : DEFAULT_ESCROW_RECONCILIATION_SWEEP_INTERVAL_MS;
  }
}
