import { Injectable } from '@nestjs/common';
import { EscrowService } from '../escrow/escrow.service';
import { GigService } from '../gig/gig.service';
import { DisputeSagaService } from '../dispute/dispute-saga.service';
import { DisputeVerdict } from '../dispute/dispute.types';
import { ReputationService } from '../reputation/reputation.service';
import { MigrationRunnerService } from '../migration/migration-runner.service';
import { EscrowReconciliationService } from '../escrow-reconciliation/escrow-reconciliation.service';
import {
  ADMIN_OVERVIEW_REPUTATION_TOP_N,
  AnalyticsOverview,
  DisputeAnalytics,
  EscrowAnalytics,
  GigAnalytics,
  MigrationAnalytics,
  ReconciliationAnalytics,
  ReputationAnalytics,
} from './admin.types';

/**
 * Read-only aggregation over the existing domain services — no new persistence of its own.
 * Every figure here is a derived view (counts, sums, groupings) of state each module already
 * owns and exposes, so there is nothing here that could drift from the source of truth.
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly escrowService: EscrowService,
    private readonly gigService: GigService,
    private readonly disputeSagaService: DisputeSagaService,
    private readonly reputationService: ReputationService,
    private readonly migrationRunnerService: MigrationRunnerService,
    private readonly reconciliationService: EscrowReconciliationService,
  ) {}

  async getOverview(): Promise<AnalyticsOverview> {
    const [escrows, gigs, disputes, reputation, migrations, reconciliation] = await Promise.all([
      this.getEscrowAnalytics(),
      this.getGigAnalytics(),
      this.getDisputeAnalytics(),
      this.getReputationAnalytics(),
      this.getMigrationAnalytics(),
      this.getReconciliationAnalytics(),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      escrows,
      gigs,
      disputes,
      reputation,
      migrations,
      reconciliation,
    };
  }

  async getEscrowAnalytics(): Promise<EscrowAnalytics> {
    const escrows = await this.escrowService.findAll();
    const totalValueXLM = escrows.reduce((sum, escrow) => sum + (Number(escrow.amountXLM) || 0), 0);
    return {
      total: escrows.length,
      byStatus: this.tally(escrows.map(escrow => escrow.status)),
      totalValueXLM,
    };
  }

  async getGigAnalytics(): Promise<GigAnalytics> {
    const gigs = await this.gigService.findAll();
    return { total: gigs.length, byStatus: this.tally(gigs.map(gig => gig.status)) };
  }

  async getDisputeAnalytics(): Promise<DisputeAnalytics> {
    const sagas = await this.disputeSagaService.findAll();
    return {
      total: sagas.length,
      byStep: this.tally(sagas.map(saga => saga.currentStep)),
      byVerdict: this.tally(
        sagas.map(saga => saga.verdict).filter((verdict): verdict is DisputeVerdict => !!verdict),
      ),
    };
  }

  async getReputationAnalytics(): Promise<ReputationAnalytics> {
    const [trackedAddresses, topAddresses] = await Promise.all([
      this.reputationService.getTrackedAddressCount(),
      this.reputationService.getLeaderboard(ADMIN_OVERVIEW_REPUTATION_TOP_N),
    ]);
    return { trackedAddresses, topAddresses };
  }

  async getMigrationAnalytics(): Promise<MigrationAnalytics> {
    const runs = await this.migrationRunnerService.findAll();
    return { total: runs.length, byStatus: this.tally(runs.map(run => run.status)) };
  }

  async getReconciliationAnalytics(): Promise<ReconciliationAnalytics> {
    const runs = await this.reconciliationService.findAll();
    const lastRunAt = runs.reduce<string | undefined>(
      (latest, run) => (!latest || run.completedAt > latest ? run.completedAt : latest),
      undefined,
    );

    return {
      totalRuns: runs.length,
      totalDriftsDetected: runs.reduce((sum, run) => sum + run.driftCount, 0),
      totalDriftsRepaired: runs.reduce((sum, run) => sum + run.repairedCount, 0),
      lastRunAt,
    };
  }

  private tally(values: string[]): Record<string, number> {
    return values.reduce<Record<string, number>>((acc, value) => {
      acc[value] = (acc[value] ?? 0) + 1;
      return acc;
    }, {});
  }
}
