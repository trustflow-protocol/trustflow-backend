import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../common/database/database.service';

export interface AuditLogEntry {
  operation: string;
  user: string;
  entityId: string;
  entityType: string;
  beforeState?: unknown;
  afterState?: unknown;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService implements OnModuleInit {
  private readonly logger = new Logger(AuditService.name);

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
        await this.db.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_id, entity_type);`);
      } catch (err) {
        this.logger.error('Failed to initialize audit_logs table', err instanceof Error ? err.stack : String(err));
      }
    }
  }

  async logOperation(entry: AuditLogEntry): Promise<void> {
    if (!this.db.isConfigured) {
      this.logger.warn(`Audit disabled: ${entry.operation} by ${entry.user}`);
      return;
    }
    try {
      await this.db.query(
        `INSERT INTO audit_logs (operation, "user", entity_id, entity_type, before_state, after_state, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          entry.operation,
          entry.user,
          entry.entityId,
          entry.entityType,
          entry.beforeState ? JSON.stringify(entry.beforeState) : null,
          entry.afterState ? JSON.stringify(entry.afterState) : null,
          entry.metadata ? JSON.stringify(entry.metadata) : null,
        ]
      );
    } catch (error) {
      this.logger.error('Failed to write audit log', error instanceof Error ? error.stack : String(error));
    }
  }

  async queryLogs(entityId: string, entityType: string): Promise<any[]> {
    if (!this.db.isConfigured) return [];
    try {
      const result = await this.db.query(
        `SELECT * FROM audit_logs WHERE entity_id = $1 AND entity_type = $2 ORDER BY created_at DESC`,
        [entityId, entityType]
      );
      return result.rows;
    } catch (error) {
      this.logger.error('Failed to query audit logs', error instanceof Error ? error.stack : String(error));
      return [];
    }
  }
}
