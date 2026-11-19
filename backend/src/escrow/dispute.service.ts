import { Injectable, Logger } from '@nestjs/common';
import { EscrowService } from './escrow.service';

export interface JurorAssignment {
  escrowId: string;
  jurorAddress: string;
  assignedAt: string;
  conflictFlagged: boolean;
  conflictReason?: string;
}

export interface JurorAssignmentResult {
  escrowId: string;
  assignments: JurorAssignment[];
  /** Jurors assigned despite a detected conflict (always explicitly flagged). */
  conflicted: JurorAssignment[];
  /** Jurors assigned with no detected conflict. */
  clean: JurorAssignment[];
}

export interface Juror {
  address: string;
  registeredAt: string;
  active: boolean;
}

/**
 * Handles dispute juror assignment with conflict-of-interest detection.
 *
 * Bug fix: previously juror selection was purely random over the eligible
 * pool with no relationship-graph lookup, so a juror with a long transaction
 * history with one of the disputants could be silently assigned. This service
 * checks each candidate against prior escrow counterparty relationships and
 * flags (or avoids) conflicted jurors.
 */
@Injectable()
export class DisputeService {
  private readonly logger = new Logger(DisputeService.name);
  private jurors: Map<string, Juror> = new Map();
  /** escrowId -> assignments */
  private assignments: Map<string, JurorAssignment[]> = new Map();

  constructor(private readonly escrowService: EscrowService) {}

  // ---- Juror pool ----

  registerJuror(address: string): Juror {
    const existing = this.jurors.get(address);
    if (existing) {
      existing.active = true;
      return existing;
    }
    const juror: Juror = {
      address,
      registeredAt: new Date().toISOString(),
      active: true,
    };
    this.jurors.set(address, juror);
    return juror;
  }

  getJurorPool(): string[] {
    return [...this.jurors.values()].filter(j => j.active).map(j => j.address);
  }

  // ---- Conflict detection ----

  /**
   * Detect whether a juror has a prior escrow counterparty relationship with
   * either disputant. A "prior relationship" means the juror was the depositor
   * or beneficiary in any escrow where a disputant was the other party.
   */
  async detectConflict(
    jurorAddress: string,
    partyA: string,
    partyB: string,
  ): Promise<{ flagged: boolean; reason?: string }> {
    const all = await this.escrowService.findAll();
    for (const escrow of all) {
      // Juror was depositor and a disputant was the beneficiary.
      if (
        escrow.depositor === jurorAddress &&
        (escrow.beneficiary === partyA || escrow.beneficiary === partyB)
      ) {
        const counterparty = escrow.beneficiary === partyA ? partyA : partyB;
        return {
          flagged: true,
          reason: `Prior escrow as depositor with disputant ${counterparty}`,
        };
      }
      // Juror was beneficiary and a disputant was the depositor.
      if (
        escrow.beneficiary === jurorAddress &&
        (escrow.depositor === partyA || escrow.depositor === partyB)
      ) {
        const counterparty = escrow.depositor === partyA ? partyA : partyB;
        return {
          flagged: true,
          reason: `Prior escrow as beneficiary with disputant ${counterparty}`,
        };
      }
    }
    return { flagged: false };
  }

  // ---- Assignment ----

  /**
   * Assign jurors to a dispute.
   *
   * Jurors with no detected conflict are assigned first. If there aren't
   * enough clean jurors, conflicted jurors fill the remaining slots but are
   * explicitly flagged so the conflict is always visible — never silently
   * assigned.
   *
   * @param escrowId  The disputed escrow
   * @param count     Number of jurors to assign
   */
  async assignJurors(escrowId: string, count: number): Promise<JurorAssignmentResult> {
    const escrow = await this.escrowService.findById(escrowId);
    if (!escrow) throw new Error('Escrow not found');

    // Eligible pool: active jurors who are not themselves a disputant.
    const pool = this.getJurorPool().filter(
      addr => addr !== escrow.depositor && addr !== escrow.beneficiary,
    );

    if (pool.length === 0) {
      throw new Error('No eligible jurors available in the pool');
    }

    // Detect conflicts for every candidate up front.
    const conflictReports = await Promise.all(
      pool.map(async address => ({
        address,
        ...(await this.detectConflict(address, escrow.depositor, escrow.beneficiary)),
      })),
    );

    const clean = conflictReports.filter(c => !c.flagged);
    const conflicted = conflictReports.filter(c => c.flagged);

    // Shuffle both pools for random selection.
    this.shuffle(clean);
    this.shuffle(conflicted);

    const selected: { address: string; flagged: boolean; reason?: string }[] = [];

    // Prefer clean jurors first.
    for (const c of clean) {
      if (selected.length >= count) break;
      selected.push({ address: c.address, flagged: false });
    }

    // Fill remaining slots with flagged jurors (recorded with the flag).
    for (const c of conflicted) {
      if (selected.length >= count) break;
      selected.push({ address: c.address, flagged: true, reason: c.reason });
    }

    if (selected.length < count) {
      this.logger.warn(
        `Only ${selected.length} of ${count} requested jurors could be assigned ` +
          `(pool=${pool.length}, clean=${clean.length}, conflicted=${conflicted.length})`,
      );
    }

    const now = new Date().toISOString();
    const assignments: JurorAssignment[] = selected.map(s => ({
      escrowId,
      jurorAddress: s.address,
      assignedAt: now,
      conflictFlagged: s.flagged,
      conflictReason: s.reason,
    }));

    this.assignments.set(escrowId, assignments);

    return {
      escrowId,
      assignments,
      conflicted: assignments.filter(a => a.conflictFlagged),
      clean: assignments.filter(a => !a.conflictFlagged),
    };
  }

  async getAssignments(escrowId: string): Promise<JurorAssignment[]> {
    return this.assignments.get(escrowId) ?? [];
  }

  private shuffle<T>(arr: T[]): void {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }
}
