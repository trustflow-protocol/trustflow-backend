import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';

export type EscrowStatus = 'pending' | 'active' | 'released' | 'disputed' | 'cancelled';

export interface Escrow {
  id: string;
  depositor: string;
  beneficiary: string;
  amountXLM: string;
  status: EscrowStatus;
  createdAt: string;
  disputeReason?: string;
  disputedAt?: string;
  /** On-chain escrow identifier, set once this row is linked to its contract counterpart. */
  contractEscrowId?: string;
}

/** Chain-verified fields the reconciler may write when repairing drift. */
export interface ChainStatePatch {
  status?: EscrowStatus;
  amountXLM?: string;
}

/** Fields required to backfill a DB row for an escrow discovered on-chain but never recorded. */
export interface ChainEscrowSeed {
  contractEscrowId: string;
  depositor: string;
  beneficiary: string;
  amountXLM: string;
  status: EscrowStatus;
}

@Injectable()
export class EscrowService {
  private escrows: Map<string, Escrow> = new Map();

  async create(depositor: string, beneficiary: string, amountXLM: string): Promise<Escrow> {
    const id = `esc-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const escrow: Escrow = {
      id,
      depositor,
      beneficiary,
      amountXLM,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.escrows.set(id, escrow);
    return escrow;
  }

  async findById(id: string): Promise<Escrow | undefined> {
    return this.escrows.get(id);
  }

  async findByDepositor(address: string): Promise<Escrow[]> {
    return [...this.escrows.values()].filter(e => e.depositor === address);
  }

  async findAll(): Promise<Escrow[]> {
    return [...this.escrows.values()];
  }

  async findByContractEscrowId(contractEscrowId: string): Promise<Escrow | undefined> {
    return [...this.escrows.values()].find(e => e.contractEscrowId === contractEscrowId);
  }

  /** Links a DB row to its on-chain counterpart so the reconciler can diff the two. */
  async linkContractEscrowId(id: string, contractEscrowId: string): Promise<Escrow> {
    const escrow = this.escrows.get(id);
    if (!escrow) throw new Error('Escrow not found');
    escrow.contractEscrowId = contractEscrowId;
    return escrow;
  }

  /**
   * Overwrites status/amount directly from chain-verified state. This bypasses the
   * transition guards in release()/raiseDispute() by design — it exists for the
   * reconciler to correct DB drift once the chain is already known to be ahead,
   * not for driving ordinary business-flow transitions.
   */
  async applyChainState(id: string, patch: ChainStatePatch): Promise<Escrow> {
    const escrow = this.escrows.get(id);
    if (!escrow) throw new Error('Escrow not found');
    if (patch.status !== undefined) escrow.status = patch.status;
    if (patch.amountXLM !== undefined) escrow.amountXLM = patch.amountXLM;
    return escrow;
  }

  /** Creates a DB row for an escrow found on-chain but never recorded (e.g. a missed creation event). */
  async createFromChainState(seed: ChainEscrowSeed): Promise<Escrow> {
    const id = `esc-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const escrow: Escrow = {
      id,
      depositor: seed.depositor,
      beneficiary: seed.beneficiary,
      amountXLM: seed.amountXLM,
      status: seed.status,
      createdAt: new Date().toISOString(),
      contractEscrowId: seed.contractEscrowId,
    };
    this.escrows.set(id, escrow);
    return escrow;
  }

  async release(id: string): Promise<Escrow> {
    const escrow = this.escrows.get(id);
    if (!escrow) throw new Error('Escrow not found');
    escrow.status = 'released';
    return escrow;
  }

  async raiseDispute(id: string, reason?: string): Promise<Escrow> {
    const escrow = this.escrows.get(id);
    if (!escrow) throw new Error('Escrow not found');
    if (escrow.status === 'released') throw new Error('Cannot dispute a released escrow');
    if (escrow.status === 'disputed') throw new Error('Escrow is already disputed');

    escrow.status = 'disputed';
    escrow.disputeReason = reason;
    escrow.disputedAt = new Date().toISOString();

    return escrow;
  }
}
