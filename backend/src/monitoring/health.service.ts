import { Injectable } from '@nestjs/common';

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'down';
  checks: Record<string, boolean>;
  uptime: number;
}

@Injectable()
export class HealthService {
  private readonly startTime = Date.now();

  async check(): Promise<HealthStatus> {
    const checks: Record<string, boolean> = {
      api: true,
      stellar: await this.checkStellar(),
      memory: process.memoryUsage().heapUsed < 500 * 1024 * 1024,
    };
    const failing = Object.values(checks).filter(v => !v).length;
    return {
      status: failing === 0 ? 'ok' : failing < 2 ? 'degraded' : 'down',
      checks,
      uptime: Date.now() - this.startTime,
    };
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
