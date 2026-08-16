import { ChainEscrowRecord } from './escrow-reconciliation.types';

/**
 * Contract for reading the canonical on-chain escrow state used by the reconciler.
 * Kept separate from EscrowService (the DB side) so drift detection compares two
 * independent sources of truth, and so the chain-reading strategy (Soroban RPC today,
 * possibly an indexer later) can change without touching reconciliation logic.
 */
export abstract class EscrowChainStateClient {
  /** Current on-chain state for one escrow, or undefined if the contract holds no record for it. */
  abstract getEscrow(contractEscrowId: string): Promise<ChainEscrowRecord | undefined>;
}
