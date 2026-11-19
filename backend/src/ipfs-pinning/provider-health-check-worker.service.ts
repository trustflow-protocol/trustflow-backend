import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import { DistributedLockService } from '../common/redis/distributed-lock.service';
import { ProviderHealthService } from './provider-health.service';
import { IpfsPinProvider, PIN_PROVIDERS } from './providers/ipfs-provider.interface';
import { computeCidV1Raw } from './cid.util';
import { DEFAULT_PROVIDER_HEALTH_CHECK_INTERVAL_MS } from './ipfs-pinning.types';
import { config } from '../config/env.config';

const LOCK_KEY = 'lock:provider-health-check-sweep';

/** Tiny fixed payload pinned and immediately unpinned against every provider each sweep. */
const PROBE_PAYLOAD = Buffer.from('trustflow-provider-health-probe');

/**
 * Periodically exercises each provider's actual pin/verify/unpin endpoints with a small
 * throwaway payload, rather than relying solely on whatever health signal real traffic
 * happens to produce (#970). A provider whose pin-upload auth is misconfigured can still
 * answer a generic status/ping endpoint, which previously meant it could be reported
 * healthy indefinitely until the next real pin request happened to hit it.
 *
 * Interval is configurable via IPFS_PROVIDER_HEALTH_CHECK_INTERVAL_MS (milliseconds); set
 * to 0 or a negative value to disable the probe entirely (e.g. in tests). It defaults to a
 * longer interval than the re-pin sweep since it performs a real round trip against every
 * provider on every tick, not just a re-verify of existing pins.
 *
 * Runs behind the same Redis distributed-lock scheme as `RepinWorkerService` so only one
 * instance's tick actually probes providers when multiple instances are deployed.
 */
@Injectable()
export class ProviderHealthCheckWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new SanitizedLogger(ProviderHealthCheckWorkerService.name);
  private timer?: NodeJS.Timeout;
  private currentLockToken?: string;
  /** Guards against a slow sweep still running when the next tick fires. */
  private sweeping = false;

  constructor(
    @Inject(PIN_PROVIDERS) private readonly providers: IpfsPinProvider[],
    private readonly providerHealth: ProviderHealthService,
    private readonly lock: DistributedLockService,
  ) {}

  onModuleInit(): void {
    const intervalMs = this.getIntervalMs();
    if (intervalMs <= 0) {
      this.logger.log(
        'Provider health-check worker disabled (IPFS_PROVIDER_HEALTH_CHECK_INTERVAL_MS <= 0)',
      );
      return;
    }

    this.timer = setInterval(() => {
      this.tick(intervalMs).catch(error =>
        this.logger.error('Provider health-check sweep failed', error),
      );
    }, intervalMs);
    this.timer.unref?.();

    this.logger.log(`Provider health-check worker started — probing every ${intervalMs}ms`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.currentLockToken) {
      await this.lock.release(LOCK_KEY, this.currentLockToken);
      this.currentLockToken = undefined;
    }
  }

  private async tick(intervalMs: number): Promise<void> {
    if (this.sweeping) {
      this.logger.warn('Previous provider health-check sweep still in flight — skipping this tick');
      return;
    }
    const token = await this.lock.tryAcquire(LOCK_KEY, Math.ceil(intervalMs * 1.5));
    if (!token) {
      return; // another instance is holding the lock for this tick
    }
    this.currentLockToken = token;
    this.sweeping = true;
    try {
      await this.runOnce();
    } finally {
      this.sweeping = false;
      await this.lock.release(LOCK_KEY, token);
      this.currentLockToken = undefined;
    }
  }

  /** Probes every registered provider once. Exposed so it can also be triggered manually (e.g. from tests). */
  async runOnce(): Promise<void> {
    const cid = computeCidV1Raw(PROBE_PAYLOAD);
    await Promise.all(this.providers.map(provider => this.probe(provider, cid)));
  }

  private async probe(provider: IpfsPinProvider, cid: string): Promise<void> {
    const startedAt = Date.now();
    try {
      await provider.pin(cid, PROBE_PAYLOAD);
      const verified = await provider.verify(cid);
      if (!verified) throw new Error('Provider did not confirm the probe pin after upload');

      await this.providerHealth.recordPinSuccess(provider.name, Date.now() - startedAt);
    } catch (error) {
      this.logger.warn(
        `Provider health probe failed for ${provider.name}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await this.providerHealth.recordPinFailure(
        provider.name,
        Date.now() - startedAt,
        error as Error,
      );
      return;
    }

    // Cleanup is best-effort and kept out of the success/failure signal above: a provider
    // that pins and verifies correctly but fails to release this throwaway probe pin is not
    // exhibiting the failure mode this worker exists to catch.
    try {
      await provider.unpin(cid);
    } catch (error) {
      this.logger.warn(
        `Provider health probe: failed to clean up probe pin on ${provider.name}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private getIntervalMs(): number {
    return (
      config.IPFS_PROVIDER_HEALTH_CHECK_INTERVAL_MS ?? DEFAULT_PROVIDER_HEALTH_CHECK_INTERVAL_MS
    );
  }
}
