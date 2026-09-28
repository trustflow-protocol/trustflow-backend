import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { SanitizedLogger } from '../logging/sanitized-logger';
import { redactError } from '../logging/redaction';
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
  private readonly logger = new SanitizedLogger(DatabaseService.name);
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
        this.logger.warn(
          `Slow query detected: ${duration.toFixed(2)}ms\nQuery: ${this.describeQuery(text)}`,
        );
        if (this.metrics) {
          this.metrics.increment('db_slow_query_count');
        }
      }
      return result;
    } catch (error) {
      const duration = performance.now() - startTime;
      this.logger.error(
        `Query failed after ${duration.toFixed(2)}ms\nQuery: ${this.describeQuery(text)}\nReason: ${redactError(error)}`,
      );
      if (this.metrics) {
        this.metrics.increment('db_query_error_count');
      }
      throw error;
    }
  }

  /**
   * Reduces a SQL statement to a loggable shape: literals are replaced with `?` and the whole
   * string is truncated.
   *
   * The raw `text` used to be logged verbatim on both the slow-query and the failure path. A
   * caller that builds SQL by interpolation (rather than using `$1` placeholders) put live
   * values — including the `before_state`/`after_state` JSONB columns the audit log writes —
   * straight into the logs. Values are not needed to diagnose a slow or failing query, so
   * they are stripped rather than redacted field-by-field.
   */
  private describeQuery(text: string): string {
    const withoutLiterals = text
      .replace(/'(?:[^']|'')*'/g, '?')
      .replace(/\b\d+\.\d+\b/g, '?')
      .replace(/\b\d+\b/g, '?')
      .replace(/\$\d+/g, '?');
    return withoutLiterals.length > 200 ? `${withoutLiterals.slice(0, 200)}…` : withoutLiterals;
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
