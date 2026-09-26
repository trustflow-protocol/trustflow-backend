import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Escrow, EscrowService } from '../escrow/escrow.service';
import { WebhookService } from '../webhook/webhook.service';
import { mapWithConcurrency } from '../common/concurrency';
import { EscrowChainStateClient } from './escrow-chain-state.client';
import { EscrowReconciliationStateStore } from './escrow-reconciliation-state.store';
import {
  ChainEscrowRecord,
  DriftRecord,
  DriftType,
  RECONCILIATION_EVENTS,
  DEFAULT_ESCROW_RECONCILIATION_SWEEP_CONCURRENCY,
  ReconciliationError,
  ReconciliationRun,
} from './escrow-reconciliation.types';

interface ReconciliationTarget {
  contractEscrowId: string;
  escrow?: Escrow;
}

/**
 * Deterministically diffs on-chain escrow state against the DB and repairs drift
 * caused by missed events or partial writes, treating the chain as the source of
 * truth for status and amount once an escrow is linked to a contract ID.
 *
 * Full contract-storage enumeration isn't available without an off-chain indexer,
 * so "escrow exists on chain but never made it into the DB" (a missed creation
 * event) is only detected for `contractEscrowId`s a caller explicitly supplies —
 * e.g. from an ops backfill list — rather than by scanning the entire contract.
 */
@Injectable()
export class EscrowReconciliationService {
  private readonly logger = new Logger(EscrowReconciliationService.name);

  constructor(
    private readonly escrowService: EscrowService,
    private readonly chainClient: EscrowChainStateClient,
    private readonly webhookService: WebhookService,
    private readonly store: EscrowReconciliationStateStore,
  ) {}

  async findById(runId: string): Promise<ReconciliationRun | undefined> {
    return this.store.findById(runId);
  }

  async findAll(): Promise<ReconciliationRun[]> {
    return this.store.findAll();
  }

  async reconcile(extraContractEscrowIds: string[] = []): Promise<ReconciliationRun> {
    const runId = `recon-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const startedAt = new Date().toISOString();
    const drifts: DriftRecord[] = [];
    const errors: ReconciliationError[] = [];

    const dbEscrows = await this.escrowService.findAll();
    const linked = dbEscrows.filter(e => e.contractEscrowId);
    const knownIds = new Set(linked.map(e => e.contractEscrowId as string));

    const targets: ReconciliationTarget[] = [
      ...linked.map(escrow => ({
        contractEscrowId: escrow.contractEscrowId as string,
        escrow,
      })),
      ...extraContractEscrowIds
        .filter(contractEscrowId => !knownIds.has(contractEscrowId))
        .map(contractEscrowId => ({ contractEscrowId })),
    ];
    const chainReads = await mapWithConcurrency(targets, this.getReadConcurrency(), target =>
      this.chainClient.getEscrow(target.contractEscrowId),
    );

    for (let index = 0; index < targets.length; index++) {
      const target = targets[index];
      const result = chainReads[index];
      if (result.status === 'rejected') {
        errors.push(this.recordError(target.contractEscrowId, result.reason));
        continue;
      }

      const chainEscrow = result.value;
      const escrow = target.escrow;

      if (escrow && !chainEscrow) {
        drifts.push(
          this.recordDrift(
            DriftType.MISSING_ON_CHAIN,
            target.contractEscrowId,
            { status: escrow.status, amountXLM: escrow.amountXLM },
            undefined,
          ),
        );
        continue;
      }

      const fieldDrifts: DriftRecord[] = [];
      if (escrow && chainEscrow && chainEscrow.status !== escrow.status) {
        fieldDrifts.push(
          this.recordDrift(
            DriftType.STATUS_MISMATCH,
            target.contractEscrowId,
            { status: escrow.status },
            { status: chainEscrow.status },
          ),
        );
      }
      if (escrow && chainEscrow && chainEscrow.amountXLM !== escrow.amountXLM) {
        fieldDrifts.push(
          this.recordDrift(
            DriftType.AMOUNT_MISMATCH,
            target.contractEscrowId,
            { amountXLM: escrow.amountXLM },
            { amountXLM: chainEscrow.amountXLM },
          ),
        );
      }

      if (escrow && chainEscrow && fieldDrifts.length > 0) {
        await this.repair(fieldDrifts, escrow.id, chainEscrow);
        drifts.push(...fieldDrifts);
      }

      if (!escrow && chainEscrow) {
        const drift = this.recordDrift(
          DriftType.MISSING_IN_DB,
          target.contractEscrowId,
          undefined,
          chainEscrow,
        );
        await this.repairMissingInDb(drift, chainEscrow);
        drifts.push(drift);
      }
    }

    const run: ReconciliationRun = {
      runId,
      startedAt,
      completedAt: new Date().toISOString(),
      checked: targets.length,
      driftCount: drifts.length,
      repairedCount: drifts.filter(d => d.repaired).length,
      drifts,
      errorCount: errors.length,
      errors,
    };

    await this.store.save(run);

    if (drifts.length > 0 || errors.length > 0) {
      this.logger.warn(
        `Reconciliation ${runId}: ${drifts.length} drift(s) and ${errors.length} read error(s) ` +
          `across ${targets.length} escrow(s)`,
      );
      await this.webhookService.dispatch(RECONCILIATION_EVENTS.DRIFT_DETECTED, run);
    } else {
      this.logger.log(
        `Reconciliation ${runId}: no drift or read errors across ${targets.length} escrow(s)`,
      );
    }

    return run;
  }

  private getReadConcurrency(): number {
    const raw = Number(process.env.ESCROW_RECONCILIATION_SWEEP_CONCURRENCY);
    return Number.isFinite(raw) && raw > 0
      ? Math.max(1, Math.floor(raw))
      : DEFAULT_ESCROW_RECONCILIATION_SWEEP_CONCURRENCY;
  }

  private recordError(contractEscrowId: string, reason: unknown): ReconciliationError {
    const message = reason instanceof Error ? reason.message : String(reason);
    this.logger.error(`Failed to read chain state for escrow ${contractEscrowId}: ${message}`);
    return {
      contractEscrowId,
      message,
      occurredAt: new Date().toISOString(),
    };
  }

  private recordDrift(
    driftType: DriftType,
    contractEscrowId: string,
    dbValue: Partial<ChainEscrowRecord> | undefined,
    chainValue: Partial<ChainEscrowRecord> | undefined,
  ): DriftRecord {
    return {
      contractEscrowId,
      driftType,
      dbValue,
      chainValue,
      repaired: false,
      detectedAt: new Date().toISOString(),
    };
  }

  /** Applies both status and amount from chain in a single write, marking every field-level drift it covers. */
  private async repair(
    fieldDrifts: DriftRecord[],
    escrowId: string,
    chainEscrow: ChainEscrowRecord,
  ): Promise<void> {
    try {
      await this.escrowService.applyChainState(escrowId, {
        status: chainEscrow.status,
        amountXLM: chainEscrow.amountXLM,
      });
      for (const drift of fieldDrifts) drift.repaired = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const drift of fieldDrifts) drift.repairError = message;
      this.logger.error(
        `Failed to repair drift for escrow ${escrowId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async repairMissingInDb(
    drift: DriftRecord,
    chainEscrow: ChainEscrowRecord,
  ): Promise<void> {
    try {
      const created = await this.escrowService.createFromChainState(chainEscrow);
      drift.repaired = true;
      await this.webhookService.dispatch(RECONCILIATION_EVENTS.ESCROW_BACKFILLED, {
        escrowId: created.id,
        contractEscrowId: chainEscrow.contractEscrowId,
      });
    } catch (error) {
      drift.repairError = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to backfill missing escrow ${drift.contractEscrowId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
