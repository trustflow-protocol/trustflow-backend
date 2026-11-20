import { Injectable, OnModuleInit } from '@nestjs/common';
import { Readable } from 'stream';
import { createHash } from 'crypto';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import { DatabaseService } from '../common/database/database.service';
import { requestContextStorage } from '../common/logging/request-context';

export interface AuditLogEntry {
  operation: string;
  user: string;
  entityId: string;
  entityType: string;
  beforeState?: unknown;
  afterState?: unknown;
  metadata?: Record<string, unknown>;
}

export interface AuditExportFilter {
  /** Inclusive lower bound (ISO-8601 or Date). */
  startDate?: Date;
  /** Inclusive upper bound (ISO-8601 or Date). */
  endDate?: Date;
  /** Filter to a specific escrow / entity ID. */
  escrowId?: string;
}

export interface AuditExportResult {
  /** Readable stream of the serialised audit records. */
  stream: Readable;
  /** Hex-encoded SHA-256 digest of the full export payload (computed on-the-fly). */
  checksum: Promise<string>;
}

@Injectable()
export class AuditService implements OnModuleInit {
  private readonly logger = new SanitizedLogger(AuditService.name);

  constructor(private readonly db: DatabaseService) {}

  async onModuleInit() {
    if (this.db.isConfigured) {
      try {
        await this.db.query(`
          CREATE TABLE IF NOT EXISTS audit_logs (
            id SERIAL PRIMARY KEY,
            operation VARCHAR(255) NOT NULL,
            "user" VARCHAR(255) NOT NULL,
            entity_id VARCHAR(255) NOT NULL,
            entity_type VARCHAR(255) NOT NULL,
            before_state JSONB,
            after_state JSONB,
            metadata JSONB,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
          );
        `);
        await this.db.query(
          `CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_id, entity_type);`,
        );
        await this.db.query(
          `CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);`,
        );
      } catch (err) {
        this.logger.error(
          'Failed to initialize audit_logs table',
          err instanceof Error ? err.stack : String(err),
        );
      }
    }
  }

  async logOperation(entry: AuditLogEntry): Promise<void> {
    if (!this.db.isConfigured) {
      this.logger.warn(`Audit disabled: ${entry.operation} by ${entry.user}`);
      return;
    }
    try {
      // Use an independent connection pool that bypasses the ambient transaction
      // so audit logs persist even if the caller's business logic rolls back.
      const pool = this.db.getPool();
      await pool.query(
        `INSERT INTO audit_logs (operation, "user", entity_id, entity_type, before_state, after_state, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          entry.operation,
          entry.user,
          entry.entityId,
          entry.entityType,
          entry.beforeState ? JSON.stringify(entry.beforeState) : null,
          entry.afterState ? JSON.stringify(entry.afterState) : null,
          this.withImpersonator(entry.metadata),
        ],
      );
    } catch (error) {
      this.logger.error(
        'Failed to write audit log',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * During an impersonation session `req.user.impersonatedBy` holds the admin wallet acting
   * as the user (see JwtStrategy). Every audit entry written in that request records it, so
   * the trail shows both the impersonated wallet (`user`) and the admin behind it (#944).
   */
  private withImpersonator(metadata?: Record<string, unknown>): string | null {
    const request = requestContextStorage.getStore()?.request as
      | { user?: { impersonatedBy?: string } }
      | undefined;
    const impersonatedBy = request?.user?.impersonatedBy;
    const merged = impersonatedBy ? { ...metadata, impersonatedBy } : metadata;
    return merged ? JSON.stringify(merged) : null;
  }

  async queryLogs(entityId: string, entityType: string): Promise<any[]> {
    if (!this.db.isConfigured) return [];
    try {
      const result = await this.db.query(
        `SELECT * FROM audit_logs WHERE entity_id = $1 AND entity_type = $2 ORDER BY created_at DESC`,
        [entityId, entityType],
      );
      return result.rows;
    } catch (error) {
      this.logger.error(
        'Failed to query audit logs',
        error instanceof Error ? error.stack : String(error),
      );
      return [];
    }
  }

  /**
   * Streams audit log rows filtered by date range and/or escrow ID.
   *
   * The method returns immediately with a `Readable` stream and a `checksum`
   * promise. Data is pushed in batches of `BATCH_SIZE` rows so the entire result
   * set is never buffered in memory. The SHA-256 checksum is resolved once the
   * stream ends, enabling the caller to emit it as a response trailer / header.
   *
   * Format behaviour:
   *  - `json`  → newline-delimited JSON (one JSON object per line, no wrapping array)
   *  - `csv`   → RFC 4180-compatible CSV with a header row
   */
  exportLogs(filter: AuditExportFilter, format: 'json' | 'csv'): AuditExportResult {
    const BATCH_SIZE = 500;

    const stream = new Readable({ objectMode: false, read() {} });
    const hasher = createHash('sha256');

    /** Push bytes to both the stream and the running checksum. */
    const push = (chunk: string) => {
      const buf = Buffer.from(chunk, 'utf8');
      stream.push(buf);
      hasher.update(buf);
    };

    const checksumPromise = new Promise<string>((resolve, reject) => {
      // Run the DB cursor loop inside a self-invoking async function so we can
      // use await without blocking the constructor.
      (async () => {
        if (!this.db.isConfigured) {
          if (format === 'csv') {
            push(this.csvHeader());
          }
          stream.push(null);
          return;
        }

        try {
          const { conditions, params } = this.buildFilterClauses(filter);
          const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

          if (format === 'csv') {
            push(this.csvHeader());
          }

          let offset = 0;
          let rowsReturned: number;

          do {
            // Use queryRead — export is a read-only, analytics-style operation
            const result = await this.db.queryRead(
              `SELECT id, operation, "user", entity_id, entity_type,
                      before_state, after_state, metadata, created_at
               FROM audit_logs
               ${whereClause}
               ORDER BY created_at ASC, id ASC
               LIMIT ${BATCH_SIZE} OFFSET $${params.length + 1}`,
              [...params, offset],
            );

            rowsReturned = result.rows.length;

            for (const row of result.rows) {
              if (format === 'json') {
                push(JSON.stringify(this.normalizeRow(row)) + '\n');
              } else {
                push(this.rowToCsv(row) + '\n');
              }
            }

            offset += rowsReturned;
          } while (rowsReturned === BATCH_SIZE);

          stream.push(null);
          resolve(hasher.digest('hex'));
        } catch (err) {
          this.logger.error(
            'Audit export stream failed',
            err instanceof Error ? err.stack : String(err),
          );
          stream.destroy(err instanceof Error ? err : new Error(String(err)));
          reject(err);
        }
      })();
    });

    return { stream, checksum: checksumPromise };
  }

  // ── private helpers ────────────────────────────────────────────────────────

  private buildFilterClauses(filter: AuditExportFilter): {
    conditions: string[];
    params: unknown[];
  } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.startDate) {
      params.push(filter.startDate.toISOString());
      conditions.push(`created_at >= $${params.length}`);
    }
    if (filter.endDate) {
      params.push(filter.endDate.toISOString());
      conditions.push(`created_at <= $${params.length}`);
    }
    if (filter.escrowId) {
      params.push(filter.escrowId);
      conditions.push(`entity_id = $${params.length}`);
    }

    return { conditions, params };
  }

  private normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
    return {
      id: row.id,
      operation: row.operation,
      user: row.user,
      entity_id: row.entity_id,
      entity_type: row.entity_type,
      before_state: row.before_state ?? null,
      after_state: row.after_state ?? null,
      metadata: row.metadata ?? null,
      created_at: row.created_at,
    };
  }

  private csvHeader(): string {
    return 'id,operation,user,entity_id,entity_type,before_state,after_state,metadata,created_at\n';
  }

  private rowToCsv(row: Record<string, unknown>): string {
    const fields = [
      row.id,
      row.operation,
      row.user,
      row.entity_id,
      row.entity_type,
      row.before_state != null ? JSON.stringify(row.before_state) : '',
      row.after_state != null ? JSON.stringify(row.after_state) : '',
      row.metadata != null ? JSON.stringify(row.metadata) : '',
      row.created_at,
    ];
    return fields.map(f => this.escapeCsvField(String(f ?? ''))).join(',');
  }

  /**
   * RFC 4180: if the field contains a comma, double-quote, or newline, wrap
   * it in double-quotes and escape internal double-quotes by doubling them.
   */
  private escapeCsvField(value: string): string {
    if (/[",\r\n]/.test(value)) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }
}
