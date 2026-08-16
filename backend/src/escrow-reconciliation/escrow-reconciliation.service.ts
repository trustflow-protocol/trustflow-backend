import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { EscrowService } from '../escrow/escrow.service';
import { WebhookService } from '../webhook/webhook.service';
import { EscrowChainStateClient } from './escrow-chain-state.client';
import { EscrowReconciliationStateStore } from './escrow-reconciliation-state.store';
import {
  ChainEscrowRecord,
  DriftRecord,
  DriftType,
  RECONCILIATION_EVENTS,
  ReconciliationRun,
} from './escrow-reconciliation.types';

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

  findById(runId: string): ReconciliationRun | undefined {
    return this.store.findById(runId);
  }

  findAll(): ReconciliationRun[] {
    return this.store.findAll();
  }

  async reconcile(extraContractEscrowIds: string[] = []): Promise<ReconciliationRun> {
    const runId = `recon-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const startedAt = new Date().toISOString();
    const drifts: DriftRecord[] = [];
    let checked = 0;

    const dbEscrows = await this.escrowService.findAll();
    const linked = dbEscrows.filter(e => e.contractEscrowId);
    const knownIds = new Set(linked.map(e => e.contractEscrowId as string));

    for (const escrow of linked) {
      checked++;
      const contractEscrowId = escrow.contractEscrowId as string;
      const chainEscrow = await this.chainClient.getEscrow(contractEscrowId);

      if (!chainEscrow) {
        drifts.push(
          this.recordDrift(
            DriftType.MISSING_ON_CHAIN,
            contractEscrowId,
            { status: escrow.status, amountXLM: escrow.amountXLM },
            undefined,
          ),
        );
        continue;
      }

      const fieldDrifts: DriftRecord[] = [];
      if (chainEscrow.status !== escrow.status) {
        fieldDrifts.push(
          this.recordDrift(
            DriftType.STATUS_MISMATCH,
            contractEscrowId,
            { status: escrow.status },
            { status: chainEscrow.status },
          ),
        );
      }
      if (chainEscrow.amountXLM !== escrow.amountXLM) {
        fieldDrifts.push(
          this.recordDrift(
            DriftType.AMOUNT_MISMATCH,
            contractEscrowId,
            { amountXLM: escrow.amountXLM },
            { amountXLM: chainEscrow.amountXLM },
          ),
        );
      }

      if (fieldDrifts.length > 0) {
        await this.repair(fieldDrifts, escrow.id, chainEscrow);
        drifts.push(...fieldDrifts);
      }
    }

    for (const contractEscrowId of extraContractEscrowIds) {
      if (knownIds.has(contractEscrowId)) continue;
      checked++;

      const chainEscrow = await this.chainClient.getEscrow(contractEscrowId);
      if (!chainEscrow) continue;

      const drift = this.recordDrift(
        DriftType.MISSING_IN_DB,
        contractEscrowId,
        undefined,
        chainEscrow,
      );
      await this.repairMissingInDb(drift, chainEscrow);
      drifts.push(drift);
    }

    const run: ReconciliationRun = {
      runId,
      startedAt,
      completedAt: new Date().toISOString(),
      checked,
      driftCount: drifts.length,
      repairedCount: drifts.filter(d => d.repaired).length,
      drifts,
    };

    this.store.save(run);

    if (drifts.length > 0) {
      this.logger.warn(
        `Reconciliation ${runId}: ${drifts.length} drift(s) detected across ${checked} escrow(s)`,
      );
      await this.webhookService.dispatch(RECONCILIATION_EVENTS.DRIFT_DETECTED, run);
    } else {
      this.logger.log(`Reconciliation ${runId}: no drift across ${checked} escrow(s)`);
    }

    return run;
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
