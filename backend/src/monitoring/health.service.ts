import { Injectable, Optional } from '@nestjs/common';
import { DatabaseService } from '../common/database/database.service';

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'down';
  checks: Record<string, boolean>;
  uptime: number;
}

@Injectable()
export class HealthService {
  private readonly startTime = Date.now();

  constructor(@Optional() private readonly database?: DatabaseService) {}

  async check(): Promise<HealthStatus> {
    const checks: Record<string, boolean> = {
      api: true,
      stellar: await this.checkStellar(),
      database: await this.checkDatabase(),
      memory: process.memoryUsage().heapUsed < 500 * 1024 * 1024,
    };
    const failing = Object.values(checks).filter(v => !v).length;
    return {
      status: failing === 0 ? 'ok' : failing < 2 ? 'degraded' : 'down',
      checks,
      uptime: Date.now() - this.startTime,
    };
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
      const url = process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
      const r = await fetch(`${url}/`);
      return r.ok;
    } catch {
      return false;
    }
  }
}
