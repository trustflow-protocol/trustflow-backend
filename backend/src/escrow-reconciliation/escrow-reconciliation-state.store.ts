import { Injectable } from '@nestjs/common';
import { ReconciliationRun } from './escrow-reconciliation.types';

@Injectable()
export class EscrowReconciliationStateStore {
  private readonly runs: Map<string, ReconciliationRun> = new Map();

  save(run: ReconciliationRun): void {
    this.runs.set(run.runId, run);
  }

  findById(runId: string): ReconciliationRun | undefined {
    return this.runs.get(runId);
  }

  findAll(): ReconciliationRun[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
}
