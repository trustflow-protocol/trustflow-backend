import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { Pool, QueryResult, QueryResultRow } from 'pg';
import { PG_POOL } from './database.constants';

import { MetricsService } from '../../monitoring/metrics.service';

/**
 * Thin wrapper around the Core DB connection pool. Every query goes through here rather
 * than callers reaching for `PG_POOL` directly, so connectivity checks (`ping`) and the
 * "not configured" error message stay in one place.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly slowQueryThresholdMs = 500;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool | null,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  get isConfigured(): boolean {
    return this.pool !== null;
  }

  getPool(): Pool {
    if (!this.pool) {
      throw new Error(
        'PostgreSQL is not configured — set DATABASE_URL (or DB_HOST/DB_NAME) to enable it',
      );
    }
    return this.pool;
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    const startTime = performance.now();
    try {
      const result = await this.getPool().query<T>(text, params);
      const duration = performance.now() - startTime;
      
      this.logger.debug(`Query executed in ${duration.toFixed(2)}ms`);
      if (this.metrics) {
        this.metrics.increment('db_query_count');
      }
      
      if (duration > this.slowQueryThresholdMs) {
        this.logger.warn(`Slow query detected: ${duration.toFixed(2)}ms\nQuery: ${text}`);
        if (this.metrics) {
          this.metrics.increment('db_slow_query_count');
        }
      }
      return result;
    } catch (error) {
      const duration = performance.now() - startTime;
      this.logger.error(`Query failed after ${duration.toFixed(2)}ms\nQuery: ${text}`);
      if (this.metrics) {
        this.metrics.increment('db_query_error_count');
      }
      throw error;
    }
  }

  /**
   * Cheap connectivity check for the health endpoint. Returns `false` rather than
   * throwing on any failure — including "not configured", since Postgres is currently
   * optional infrastructure and an absent pool shouldn't itself look like an outage.
   */
  async ping(): Promise<boolean> {
    if (!this.pool) return false;
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch (error) {
      this.logger.error(
        'PostgreSQL health check failed',
        error instanceof Error ? error.stack : String(error),
      );
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool) await this.pool.end();
  }
}
