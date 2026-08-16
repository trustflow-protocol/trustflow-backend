import { EscrowStatus } from '../escrow/escrow.service';

export enum DriftType {
  STATUS_MISMATCH = 'status_mismatch',
  AMOUNT_MISMATCH = 'amount_mismatch',
  MISSING_IN_DB = 'missing_in_db',
  MISSING_ON_CHAIN = 'missing_on_chain',
}

/** Canonical on-chain view of a single escrow, as read by an EscrowChainStateClient. */
export interface ChainEscrowRecord {
  contractEscrowId: string;
  depositor: string;
  beneficiary: string;
  amountXLM: string;
  status: EscrowStatus;
}

export interface DriftRecord {
  contractEscrowId: string;
  driftType: DriftType;
  dbValue?: Partial<ChainEscrowRecord>;
  chainValue?: Partial<ChainEscrowRecord>;
  repaired: boolean;
  repairError?: string;
  detectedAt: string;
}

export interface ReconciliationRun {
  runId: string;
  startedAt: string;
  completedAt: string;
  /** Number of escrows diffed against chain state during this run. */
  checked: number;
  driftCount: number;
  repairedCount: number;
  drifts: DriftRecord[];
}

/** Webhook events emitted by the reconciler. */
export const RECONCILIATION_EVENTS = {
  DRIFT_DETECTED: 'escrow_reconciliation.drift_detected',
  ESCROW_BACKFILLED: 'escrow_reconciliation.escrow_backfilled',
} as const;

export const DEFAULT_ESCROW_RECONCILIATION_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
