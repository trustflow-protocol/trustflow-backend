import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { DatabaseService } from '../common/database/database.service';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { DrainStateService } from '../common/shutdown/drain-state.service';
import { config } from '../config/env.config';

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'down';
  checks: Record<string, boolean>;
  uptime: number;
}

export interface LivenessProbe {
  status: 'up';
}

export interface ReadinessProbe {
  status: 'ok' | 'degraded' | 'down';
  checks: Record<string, boolean>;
}

@Injectable()
export class HealthService {
  private readonly startTime = Date.now();

  constructor(
    @Optional() private readonly database?: DatabaseService,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis | null,
    @Optional() private readonly drainState?: DrainStateService,
  ) {}

  async liveness(): Promise<LivenessProbe> {
    return { status: 'up' };
  }

  /**
   * Reports `down` as soon as a shutdown has begun, regardless of dependency health.
   *
   * This is the signal that removes the instance from the load balancer's rotation. Without
   * it, readiness keeps returning 200 until the process has already exited, so the balancer
   * keeps sending requests into a closing socket — which is how a deploy turns into a burst of
   * failed transactions.
   */
  async readiness(): Promise<ReadinessProbe> {
    if (this.drainState?.isDraining()) {
      return { status: 'down', checks: { draining: false } };
    }

    const checks = await this.runAllChecks();
    const failing = Object.values(checks).filter(v => !v).length;
    return {
      status: failing === 0 ? 'ok' : failing < 2 ? 'degraded' : 'down',
      checks,
    };
  }

  async check(): Promise<HealthStatus> {
    const checks = await this.runAllChecks();
    const failing = Object.values(checks).filter(v => !v).length;
    return {
      status: failing === 0 ? 'ok' : failing < 2 ? 'degraded' : 'down',
      checks,
      uptime: Date.now() - this.startTime,
    };
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
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        config.STELLAR_HEALTH_CHECK_TIMEOUT_MS,
      );
      const url = config.STELLAR_HORIZON_URL;
      const r = await fetch(`${url}/`, { signal: controller.signal });
      clearTimeout(timeoutId);
      return r.ok;
    } catch {
      return false;
    }
  }
}
