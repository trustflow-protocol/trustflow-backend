import { Injectable, Logger } from '@nestjs/common';
import { EscrowService } from './escrow.service';

export interface SweepResult {
  processed: number;
  actedUpon: number;
  skipped: boolean;
  batches: number;
  batchSize: number;
  total: number;
  durationMs: number;
}

/**
 * Periodically sweeps all escrows to detect expired deadlines and auto-release
 * them. Addresses two scaling problems from the original fixed-batch sweep:
 *
 *  1. Adaptive batch size — scales with the total escrow count instead of a
 *     hardcoded constant, so runtime does not grow linearly while the interval
 *     stays fixed.
 *  2. Overlap guard — a slow run cannot double up with the next scheduled run;
 *     concurrent invocations are skipped (not queued) to prevent backlogs.
 */
@Injectable()
export class EscrowSweepService {
  private readonly logger = new Logger(EscrowSweepService.name);

  /** Overlap guard — prevents concurrent sweeps from doubling up. */
  private sweeping = false;

  private readonly minBatchSize: number;
  private readonly maxBatchSize: number;
  private readonly perBatchDelayMs: number;

  constructor(private readonly escrowService: EscrowService) {
    this.minBatchSize = Number(process.env.SWEEP_MIN_BATCH) || 50;
    this.maxBatchSize = Number(process.env.SWEEP_MAX_BATCH) || 500;
    this.perBatchDelayMs = Number(process.env.SWEEP_BATCH_DELAY_MS) || 200;
  }

  /**
   * Compute an adaptive batch size that scales with the total escrow count.
   *
   * Bug fix: previously the batch size was a hardcoded constant (50) regardless
   * of volume, so the sweep runtime grew linearly while the interval stayed
   * fixed — eventually causing overlapping runs.
   *
   * Scales at ~10% of total count, clamped to [minBatchSize, maxBatchSize].
   */
  computeBatchSize(totalCount: number): number {
    if (totalCount <= 0) return this.minBatchSize;
    const scaled = Math.ceil(totalCount / 10);
    return Math.min(Math.max(scaled, this.minBatchSize), this.maxBatchSize);
  }

  /**
   * Run a single sweep pass over all escrows.
   *
   * Includes an overlap guard: if a previous sweep is still running, the new
   * invocation is skipped (not queued) to prevent backlogged, overlapping runs.
   */
  async runSweep(): Promise<SweepResult> {
    // ---- Overlap guard ----
    if (this.sweeping) {
      this.logger.warn('Sweep already in progress — skipping this run to avoid overlap');
      return {
        processed: 0,
        actedUpon: 0,
        skipped: true,
        batches: 0,
        batchSize: 0,
        total: 0,
        durationMs: 0,
      };
    }

    this.sweeping = true;
    const start = Date.now();

    try {
      const all = await this.escrowService.findAll();
      const total = all.length;
      const batchSize = this.computeBatchSize(total);

      let processed = 0;
      let actedUpon = 0;
      let batches = 0;

      for (let offset = 0; offset < total; offset += batchSize) {
        const batch = all.slice(offset, offset + batchSize);

        for (const escrow of batch) {
          const acted = await this.escrowService.checkExpiry(escrow.id);
          processed++;
          if (acted) actedUpon++;
        }
        batches++;

        // Per-batch delay, skipped after the final batch.
        if (offset + batchSize < total) {
          await this.delay(this.perBatchDelayMs);
        }
      }

      const durationMs = Date.now() - start;
      this.logger.log(
        `Sweep complete: ${processed} escrows processed (${actedUpon} acted upon) ` +
          `in ${batches} batch(es) [batchSize=${batchSize}, total=${total}, ${durationMs}ms]`,
      );

      return { processed, actedUpon, skipped: false, batches, batchSize, total, durationMs };
    } finally {
      this.sweeping = false;
    }
  }

  isSweeping(): boolean {
    return this.sweeping;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
