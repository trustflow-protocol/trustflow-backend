import { ReputationScoreView } from '../reputation/reputation.types';

/** How many top-ranked reputation entries the overview embeds (full leaderboard has its own endpoint). */
export const ADMIN_OVERVIEW_REPUTATION_TOP_N = 5;

export interface EscrowAnalytics {
  total: number;
  byStatus: Record<string, number>;
  /** Sum of `amountXLM` across every escrow, regardless of status. Non-numeric amounts are treated as 0. */
  totalValueXLM: number;
}

export interface GigAnalytics {
  total: number;
  byStatus: Record<string, number>;
}

export interface DisputeAnalytics {
  total: number;
  byStep: Record<string, number>;
  /** Only sagas that have reached a verdict are counted here. */
  byVerdict: Record<string, number>;
}

export interface ReputationAnalytics {
  /** Distinct addresses with a materialized reputation score. */
  trackedAddresses: number;
  topAddresses: ReputationScoreView[];
}

export interface MigrationAnalytics {
  total: number;
  byStatus: Record<string, number>;
}

export interface ReconciliationAnalytics {
  totalRuns: number;
  totalDriftsDetected: number;
  totalDriftsRepaired: number;
  /** `completedAt` of the most recent run, if any have run yet. */
  lastRunAt?: string;
}

export interface AnalyticsOverview {
  generatedAt: string;
  escrows: EscrowAnalytics;
  gigs: GigAnalytics;
  disputes: DisputeAnalytics;
  reputation: ReputationAnalytics;
  migrations: MigrationAnalytics;
  reconciliation: ReconciliationAnalytics;
}
