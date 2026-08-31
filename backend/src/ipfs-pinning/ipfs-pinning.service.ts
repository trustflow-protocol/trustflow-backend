import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { computeCidV1Raw } from './cid.util';
import { PinContentDto } from './ipfs-pinning.dto';
import {
  DEFAULT_REPLICATION_FACTOR,
  IPFS_EVENTS,
  PinRecord,
  PinStatus,
  ProviderPinRecord,
  ProviderPinStatus,
} from './ipfs-pinning.types';
import {
  IpfsPinProvider,
  PIN_PROVIDERS,
  PinProviderName,
} from './providers/ipfs-provider.interface';
import { WebhookService } from '../webhook/webhook.service';

@Injectable()
export class IpfsPinningService {
  private readonly logger = new Logger(IpfsPinningService.name);

  /** In-memory pin record store — keyed by CID. */
  private readonly pins = new Map<string, PinRecord>();
  /** Original bytes for each pinned CID, retained so the re-pin worker can top up replication later. */
  private readonly content = new Map<string, Buffer>();

  constructor(
    @Inject(PIN_PROVIDERS) private readonly providers: IpfsPinProvider[],
    private readonly webhookService: WebhookService,
  ) {
    if (this.providers.length === 0) {
      throw new Error('IpfsPinningService requires at least one registered pin provider');
    }
  }

  // ─── Queries ──────────────────────────────────────────────────────

  findAll(): PinRecord[] {
    return [...this.pins.values()];
  }

  findByCid(cid: string): PinRecord {
    const record = this.pins.get(cid);
    if (!record) throw new NotFoundException(`Pin record for CID ${cid} not found`);
    return record;
  }

  // ─── Pinning ──────────────────────────────────────────────────────

  /**
   * Computes the content hash, verifies it against `expectedCid` (if supplied), then pins
   * across providers in priority order until `replicationFactor` providers succeed —
   * automatically failing over to the next provider whenever one throws or fails
   * post-pin verification.
   */
  async pinContent(dto: PinContentDto): Promise<PinRecord> {
    const buffer = Buffer.from(dto.content, 'base64');

    // Explicit size guard (belt-and-suspenders alongside the DTO @MaxLength check and
    // the Express body-size limit configured in main.ts).
    const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
    if (buffer.length > MAX_BYTES) {
      throw new BadRequestException(
        `Decoded content size (${buffer.length} bytes) exceeds the maximum allowed size of 10 MB`,
      );
    }

    const cid = computeCidV1Raw(buffer);

    if (dto.expectedCid && dto.expectedCid !== cid) {
      throw new BadRequestException(
        `Content hash mismatch: expected ${dto.expectedCid}, computed ${cid} from the supplied bytes`,
      );
    }

    const replicationFactor = Math.min(
      dto.replicationFactor ?? DEFAULT_REPLICATION_FACTOR,
      this.providers.length,
    );

    const isNew = !this.pins.has(cid);
    const now = new Date().toISOString();
    const record: PinRecord = this.pins.get(cid) ?? {
      cid,
      size: buffer.length,
      filename: dto.filename,
      replicationFactor,
      status: PinStatus.FAILED,
      providers: [],
      createdAt: now,
      updatedAt: now,
    };
    record.replicationFactor = Math.max(record.replicationFactor, replicationFactor);
    this.pins.set(cid, record);
    this.content.set(cid, buffer);

    await this.replicate(record, buffer);

    if (isNew && this.countHealthy(record) > 0) {
      await this.webhookService.dispatch(IPFS_EVENTS.PIN_CREATED, {
        cid: record.cid,
        replicationFactor: record.replicationFactor,
        pinnedProviders: this.healthyProviders(record),
      });
    }

    return record;
  }

  /**
   * Re-verifies every provider currently believed to hold the pin, and — if the pin has
   * dropped below its replication factor — attempts to top it up via any remaining
   * providers. Used both for the on-demand verify endpoint and the re-pin worker sweep.
   */
  async reconcile(cid: string): Promise<PinRecord> {
    const record = this.findByCid(cid);
    const before = this.countHealthy(record);
    let lostDuringThisPass = false;

    for (const entry of record.providers) {
      if (entry.status !== ProviderPinStatus.PINNED) continue;
      const provider = this.providers.find(p => p.name === entry.provider);
      if (!provider) continue;

      try {
        const stillPinned = await provider.verify(cid);
        if (!stillPinned) throw new Error('Provider reports the pin is no longer present');
        entry.lastVerifiedAt = new Date().toISOString();
      } catch (error) {
        entry.status = ProviderPinStatus.FAILED;
        entry.lastError = error instanceof Error ? error.message : String(error);
        lostDuringThisPass = true;
        this.logger.warn(`Pin ${cid} lost on provider ${entry.provider}: ${entry.lastError}`);
        await this.webhookService.dispatch(IPFS_EVENTS.PIN_LOST, { cid, provider: entry.provider });
      }
    }

    const buffer = this.content.get(cid);
    if (this.countHealthy(record) < record.replicationFactor && buffer) {
      await this.replicate(record, buffer).catch(error => {
        this.logger.warn(
          `Reconcile: unable to restore full replication for ${cid}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    } else {
      this.finalizeStatus(record);
    }

    // Fires when this pass brought replication back up to full health — either by
    // topping up a pin that entered this call already degraded, or by recovering
    // from a loss detected during this same pass (net count unchanged but a
    // different provider now holds it).
    const after = this.countHealthy(record);
    if (after >= record.replicationFactor && (after > before || lostDuringThisPass)) {
      await this.webhookService.dispatch(IPFS_EVENTS.PIN_RESTORED, {
        cid,
        healthyProviders: after,
      });
    }

    return record;
  }

  /** Unpins the CID from every provider currently holding it. */
  async unpin(cid: string): Promise<PinRecord> {
    const record = this.findByCid(cid);

    await Promise.all(
      record.providers
        .filter(entry => entry.status === ProviderPinStatus.PINNED)
        .map(async entry => {
          const provider = this.providers.find(p => p.name === entry.provider);
          try {
            await provider?.unpin(cid);
          } catch (error) {
            this.logger.warn(
              `Failed to unpin ${cid} from ${entry.provider}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          } finally {
            entry.status = ProviderPinStatus.UNPINNED;
          }
        }),
    );

    record.status = PinStatus.UNPINNED;
    record.updatedAt = new Date().toISOString();
    this.content.delete(cid);

    await this.webhookService.dispatch(IPFS_EVENTS.PIN_REMOVED, { cid });
    return record;
  }

  // ─── Internal helpers ─────────────────────────────────────────────

  /** Attempts to pin `content` to enough not-yet-healthy providers to reach the replication factor. */
  private async replicate(record: PinRecord, content: Buffer): Promise<void> {
    const healthyNames = new Set(this.healthyProviders(record));
    const candidates = this.providers.filter(p => !healthyNames.has(p.name));

    for (const provider of candidates) {
      if (this.countHealthy(record) >= record.replicationFactor) break;
      await this.pinWithProvider(record, provider, content);
    }

    this.finalizeStatus(record);

    if (record.status === PinStatus.DEGRADED) {
      await this.webhookService.dispatch(IPFS_EVENTS.PIN_DEGRADED, {
        cid: record.cid,
        healthyProviders: this.countHealthy(record),
        replicationFactor: record.replicationFactor,
      });
    }

    if (this.countHealthy(record) === 0) {
      await this.webhookService.dispatch(IPFS_EVENTS.PIN_FAILED, { cid: record.cid });
      throw new ServiceUnavailableException(
        `Failed to pin ${record.cid} to any of the ${this.providers.length} registered provider(s)`,
      );
    }
  }

  private async pinWithProvider(
    record: PinRecord,
    provider: IpfsPinProvider,
    content: Buffer,
  ): Promise<void> {
    const entry = this.upsertProviderEntry(record, provider.name);
    entry.attempts += 1;

    try {
      await provider.pin(record.cid, content);
      const verified = await provider.verify(record.cid);
      if (!verified) throw new Error('Provider did not confirm the pin after upload');

      entry.status = ProviderPinStatus.PINNED;
      entry.pinnedAt = new Date().toISOString();
      entry.lastVerifiedAt = entry.pinnedAt;
      entry.lastError = undefined;
    } catch (error) {
      entry.status = ProviderPinStatus.FAILED;
      entry.lastError = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Provider ${provider.name} failed to pin ${record.cid} — failing over: ${entry.lastError}`,
      );
    }
  }

  private upsertProviderEntry(record: PinRecord, name: PinProviderName): ProviderPinRecord {
    let entry = record.providers.find(p => p.provider === name);
    if (!entry) {
      entry = { provider: name, status: ProviderPinStatus.FAILED, attempts: 0 };
      record.providers.push(entry);
    }
    return entry;
  }

  private healthyProviders(record: PinRecord): PinProviderName[] {
    return record.providers.filter(p => p.status === ProviderPinStatus.PINNED).map(p => p.provider);
  }

  private countHealthy(record: PinRecord): number {
    return this.healthyProviders(record).length;
  }

  private finalizeStatus(record: PinRecord): void {
    const healthy = this.countHealthy(record);
    if (healthy === 0) record.status = PinStatus.FAILED;
    else if (healthy < record.replicationFactor) record.status = PinStatus.DEGRADED;
    else record.status = PinStatus.HEALTHY;
    record.updatedAt = new Date().toISOString();
  }
}
