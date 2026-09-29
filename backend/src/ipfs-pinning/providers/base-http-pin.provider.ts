import { SanitizedLogger } from '../../common/logging/sanitized-logger';
import { IpfsPinProvider, PinProviderName } from './ipfs-provider.interface';

/**
 * Shared behavior for HTTP-backed pinning providers (Pinata, web3.storage, Infura, ...).
 *
 * When no API credentials are configured — the default in local dev, tests, and CI —
 * the provider falls back to an in-memory simulated store instead of making real network
 * calls, mirroring how RedisModule/DiscordService degrade gracefully without their
 * respective env vars. This keeps the failover/reconciliation logic fully testable without
 * network access while still exercising the real HTTP path in production once credentials
 * are provided.
 */
export abstract class BaseHttpPinProvider extends IpfsPinProvider {
  protected readonly logger = new SanitizedLogger(this.constructor.name);
  private readonly simulatedStore = new Map<string, Buffer>();

  abstract readonly name: PinProviderName;

  /** Returns the configured API credential, or undefined when running in simulated mode. */
  protected abstract get credential(): string | undefined;

  protected abstract sendPin(cid: string, content: Buffer, credential: string): Promise<void>;
  protected abstract sendUnpin(cid: string, credential: string): Promise<void>;
  protected abstract sendVerify(cid: string, credential: string): Promise<boolean>;

  get isConfigured(): boolean {
    return Boolean(this.credential);
  }

  async pin(cid: string, content: Buffer): Promise<void> {
    if (!this.isConfigured) {
      this.simulatedStore.set(cid, content);
      return;
    }
    await this.sendPin(cid, content, this.credential!);
  }

  async unpin(cid: string): Promise<void> {
    if (!this.isConfigured) {
      this.simulatedStore.delete(cid);
      return;
    }
    await this.sendUnpin(cid, this.credential!);
  }

  async verify(cid: string): Promise<boolean> {
    if (!this.isConfigured) {
      return this.simulatedStore.has(cid);
    }
    return this.sendVerify(cid, this.credential!);
  }
}
