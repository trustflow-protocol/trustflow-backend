export enum ReputationEventType {
  ESCROW_COMPLETED = 'escrow_completed',
  DISPUTE_WON = 'dispute_won',
  DISPUTE_LOST = 'dispute_lost',
  DISPUTE_SPLIT = 'dispute_split',
}

/** Domain-neutral outcome a caller (e.g. the dispute saga) maps its own verdict into. */
export type ReputationOutcome = 'won' | 'lost' | 'split';

/** The subset of an escrow's fields the reputation engine needs — kept minimal and decoupled from EscrowService. */
export interface EscrowParties {
  depositor: string;
  beneficiary: string;
  amountXLM: string;
}

export interface ReputationEventLogEntry {
  type: ReputationEventType;
  counterparty: string;
  contribution: number;
  occurredAt: string;
}

/** Materialized, incrementally-updated score record for a single address. */
export interface ReputationScoreRecord {
  address: string;
  score: number;
  eventCount: number;
  /** Interaction count per counterparty — drives Sybil dampening (diminishing returns on repeated pairs). */
  counterpartyCounts: Record<string, number>;
  recentEvents: ReputationEventLogEntry[];
  lastUpdatedAt: string;
}

export interface ReputationScoreView {
  address: string;
  score: number;
  eventCount: number;
  distinctCounterparties: number;
  recentEvents: ReputationEventLogEntry[];
  lastUpdatedAt: string;
}

/** Score halves every 90 days without new activity, so stale history stops dominating current trust. */
export const REPUTATION_DECAY_HALF_LIFE_MS = 90 * 24 * 60 * 60 * 1000;

export const REPUTATION_RECENT_EVENTS_LIMIT = 20;

/** Base weight per event type, before amount scaling and Sybil dampening. */
export const REPUTATION_WEIGHTS: Record<ReputationEventType, number> = {
  [ReputationEventType.ESCROW_COMPLETED]: 5,
  [ReputationEventType.DISPUTE_WON]: 2,
  [ReputationEventType.DISPUTE_LOST]: -10,
  [ReputationEventType.DISPUTE_SPLIT]: -2,
};

/** Caps how much a single high-value escrow can scale a contribution, so one whale event can't dominate. */
export const REPUTATION_MAX_AMOUNT_WEIGHT = 10;

export const REPUTATION_LEADERBOARD_DEFAULT_LIMIT = 50;
