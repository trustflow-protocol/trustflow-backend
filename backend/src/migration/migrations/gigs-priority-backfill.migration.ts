import { Injectable } from '@nestjs/common';
import { BackfillBatchResult, SchemaMigration } from '../migration.types';

export interface GigRow {
  id: string;
  title: string;
  budgetXLM: string;
  /** Legacy flag being replaced by `priority`. */
  urgent?: boolean;
  /** New column introduced by this migration (1 = low, 5 = highest). */
  priority?: number;
}

const byId = (a: GigRow, b: GigRow) => a.id.localeCompare(b.id);

/**
 * Expand/contract migration for the gigs table: replaces the legacy boolean
 * `urgent` flag with a numeric `priority` column (1-5) so gigs can be sorted
 * on a richer scale, without ever locking the table or requiring downtime.
 *
 * - expand: adds the (nullable) `priority` column alongside the existing `urgent` flag.
 * - backfill: derives `priority` from `urgent` in small batches.
 * - contract: drops the now-redundant `urgent` flag.
 */
@Injectable()
export class GigsPriorityBackfillMigration extends SchemaMigration {
  readonly name = 'gigs-add-priority-column';
  readonly targetTable = 'gigs';
  readonly description =
    'Adds a numeric priority column to gigs, backfilled from the legacy urgent flag, then drops urgent.';

  // Stand-in for the real gigs table row store this migration targets.
  private readonly rows: Map<string, GigRow> = new Map();
  private priorityColumnAdded = false;

  constructor(seedRows: GigRow[] = []) {
    super();
    for (const row of seedRows) this.rows.set(row.id, { ...row });
  }

  /** Test/inspection helper — not part of the SchemaMigration contract. */
  getRow(id: string): GigRow | undefined {
    return this.rows.get(id);
  }

  allRows(): GigRow[] {
    return [...this.rows.values()].sort(byId);
  }

  async expand(): Promise<void> {
    this.priorityColumnAdded = true;
  }

  async countPending(): Promise<number> {
    return this.allRows().filter(r => r.priority === undefined).length;
  }

  async backfillBatch(cursor: string | undefined, batchSize: number): Promise<BackfillBatchResult> {
    if (!this.priorityColumnAdded) {
      throw new Error('Cannot backfill gigs.priority before expand() has run');
    }

    const pending = this.allRows().filter(
      r => r.priority === undefined && (cursor === undefined || r.id > cursor),
    );
    const batch = pending.slice(0, batchSize);

    for (const row of batch) {
      row.priority = row.urgent ? 5 : 1;
    }

    const nextCursor = batch.length > 0 ? batch[batch.length - 1].id : cursor;
    const remaining = pending.length - batch.length;

    return { processed: batch.length, failed: 0, nextCursor, done: remaining <= 0 };
  }

  /** The destructive DDL the contract phase below stands in for, declared for the runner's pre-flight check (#971). */
  plannedContractSql(): string[] {
    return [`ALTER TABLE ${this.targetTable} DROP COLUMN urgent`];
  }

  async contract(): Promise<void> {
    for (const row of this.rows.values()) {
      delete row.urgent;
    }
  }

  async rollbackExpand(): Promise<void> {
    this.priorityColumnAdded = false;
    for (const row of this.rows.values()) {
      delete row.priority;
    }
  }

  async rollbackContract(): Promise<void> {
    for (const row of this.rows.values()) {
      if (row.urgent === undefined) {
        row.urgent = (row.priority ?? 1) >= 4;
      }
    }
  }
}
