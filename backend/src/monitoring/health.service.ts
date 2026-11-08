import { Inject, Injectable, Optional } from '@nestjs/common';
import { HealthCheckError, HealthCheckService } from '@nestjs/terminus';
import { Redis } from 'ioredis';
import { DatabaseService } from '../common/database/database.service';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { DrainStateService } from '../common/shutdown/drain-state.service';
import { config } from '../config/env.config';

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'down';
  checks: Record<string, boolean>;
  details?: HealthCheckResult;
  uptime: number;
}

export interface LivenessProbe {
  status: 'up';
}

export interface ReadinessProbe {
  status: 'ok' | 'degraded' | 'down';
  checks: Record<string, boolean>;
  details?: HealthCheckResult;
}

interface HealthCheckResult {
  status: string;
  info?: Record<string, { status: string }>;
  error?: Record<string, { status: string }>;
  details: Record<string, { status: string }>;
}

type IndicatorResult = Record<string, { status: 'up' | 'down' }>;

@Injectable()
export class HealthService {
  private readonly startTime = Date.now();

  constructor(
    @Optional() private readonly database?: DatabaseService,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis | null,
    @Optional() private readonly healthCheckService?: HealthCheckService,
    @Optional() private readonly drainState?: DrainStateService,
  ) {}

  liveness(): LivenessProbe {
    return { status: 'up' };
  }

  async readiness(): Promise<ReadinessProbe> {
    const checks = await this.runAllChecks();
    const details = await this.runTerminusHealthChecks(checks);
    if (this.drainState?.isDraining()) {
      return { status: 'down', checks, details };
    }
    // Readiness gates on external dependencies only. Local heap pressure
    // (the `memory` check) is reported in `checks`/`check()` but does not
    // make an instance unready to serve.
    const dependencies = {
      stellar: checks.stellar,
      database: checks.database,
      redis: checks.redis,
    };
    return { status: this.aggregateStatus(dependencies), checks, details };
  }

  async check(): Promise<HealthStatus> {
    const checks = await this.runAllChecks();
    const healthDetails = await this.runTerminusHealthChecks(checks);
    return {
      status: this.aggregateStatus(checks),
      checks,
      details: healthDetails,
      uptime: Date.now() - this.startTime,
    };
  }

  private aggregateStatus(checks: Record<string, boolean>): 'ok' | 'degraded' | 'down' {
    const failing = Object.values(checks).filter(v => !v).length;
    return failing === 0 ? 'ok' : failing < 2 ? 'degraded' : 'down';
  }

  private async runAllChecks(): Promise<Record<string, boolean>> {
    const [stellar, database, redis, memory] = await Promise.all([
      this.checkStellar(),
      this.checkDatabase(),
      this.checkRedis(),
      this.checkMemory(),
    ]);

    return {
      api: true,
      stellar,
      database,
      redis,
      memory,
    };
  }

  private checkMemory(): Promise<boolean> {
    return Promise.resolve(process.memoryUsage().heapUsed < 500 * 1024 * 1024);
  }

  /**
   * Redis is required infrastructure for rate limiting, idempotency keys, and
   * the outbox — closes #219. An unconfigured REDIS_URL still reports healthy
   * (this environment doesn't require Redis), but once configured a failed
   * ping counts against overall health instead of being silently invisible.
   */
  private async checkRedis(): Promise<boolean> {
    if (!this.redis) return true;
    try {
      const pong = await this.redis.ping();
      return pong === 'PONG';
    } catch {
      return false;
    }
  }

  /**
   * PostgreSQL is currently optional infrastructure — not yet a hard dependency of any
   * service — so an unconfigured pool reports healthy (true) rather than degraded. Once
   * configured, a failed ping does count against overall health.
   */
  private async checkDatabase(): Promise<boolean> {
    if (!this.database || !this.database.isConfigured) return true;
    return this.database.ping();
  }

  private async checkStellar(): Promise<boolean> {
    const controller = new AbortController();
    let timeoutId: NodeJS.Timeout | undefined;
    try {
      timeoutId = setTimeout(
        () => controller.abort(),
        config.STELLAR_HEALTH_CHECK_TIMEOUT_MS,
      );
      const url = config.STELLAR_HORIZON_URL;
      const r = await fetch(`${url}/`, { signal: controller.signal });
      return r.ok;
    } catch {
      // Includes "config not initialized" — a health probe must report
      // down/degraded, never throw.
      return false;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  // ---- Terminus indicators -------------------------------------------------
  // The boolean checks above are the source of truth for `checks`; these
  // adapt them (plus the Soroban RPC probe) to the Terminus result shape
  // exposed as `details`, without re-pinging dependencies a second time.

  private indicatorFromCheck(name: string, healthy: boolean): IndicatorResult {
    const result: IndicatorResult = { [name]: { status: healthy ? 'up' : 'down' } };
    if (!healthy) {
      throw new HealthCheckError(`${name} health check failed`, result);
    }
    return result;
  }

  private async checkPostgresIndicator(): Promise<IndicatorResult> {
    return this.indicatorFromCheck('postgres', await this.checkDatabase());
  }

  private async checkRedisIndicator(): Promise<IndicatorResult> {
    return this.indicatorFromCheck('redis', await this.checkRedis());
  }

  private async checkSorobanRpcIndicator(): Promise<IndicatorResult> {
    let sorobanUrl: string | undefined;
    try {
      sorobanUrl = config.SOROBAN_RPC_URL;
    } catch {
      return { soroban_rpc: { status: 'down' } };
    }
    if (!sorobanUrl) return { soroban_rpc: { status: 'down' } };
    const controller = new AbortController();
    let timeoutId: NodeJS.Timeout | undefined;
    try {
      timeoutId = setTimeout(
        () => controller.abort(),
        config.STELLAR_HEALTH_CHECK_TIMEOUT_MS,
      );
      const r = await fetch(sorobanUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
        signal: controller.signal,
      });
      if (!r.ok) return { soroban_rpc: { status: 'down' } };
      const body: any = await r.json();
      return {
        soroban_rpc: { status: body?.result?.status === 'healthy' ? 'up' : 'down' },
      };
    } catch {
      return { soroban_rpc: { status: 'down' } };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  private async runTerminusHealthChecks(
    checks: Record<string, boolean>,
  ): Promise<HealthCheckResult> {
    if (this.healthCheckService) {
      try {
        const result = await this.healthCheckService.check([
          async () => this.indicatorFromCheck('postgres', checks.database),
          async () => this.indicatorFromCheck('redis', checks.redis),
          async () => this.checkSorobanRpcIndicator(),
        ]);
        return result as HealthCheckResult;
      } catch (error) {
        // Terminus throws HealthCheckError carrying the aggregated result
        // when any indicator is down; surface it as `details` instead of
        // failing the whole health response.
        if (error instanceof HealthCheckError && error.causes) {
          return error.causes as HealthCheckResult;
        }
        throw error;
      }
    }

    const soroban = await this.checkSorobanRpcIndicator();
    const details: Record<string, { status: string }> = {
      postgres: { status: checks.database ? 'up' : 'down' },
      redis: { status: checks.redis ? 'up' : 'down' },
      ...soroban,
    };
    const info = Object.fromEntries(
      Object.entries(details).filter(([, v]) => v.status === 'up'),
    );
    const error = Object.fromEntries(
      Object.entries(details).filter(([, v]) => v.status !== 'up'),
    );
    return {
      status: Object.keys(error).length === 0 ? 'ok' : 'error',
      info,
      error,
      details,
    };
  }
}
