import { PinProviderName } from './providers/ipfs-provider.interface';

export { PinProviderName };

/** Overall durability status of a pinned CID across all registered providers. */
export enum PinStatus {
  /** Pinned on at least `replicationFactor` providers. */
  HEALTHY = 'HEALTHY',
  /** Pinned on at least one, but fewer than `replicationFactor`, providers. */
  DEGRADED = 'DEGRADED',
  /** Not currently pinned on any provider. */
  FAILED = 'FAILED',
  /** Explicitly unpinned by the caller, and every provider confirmed it released the pin. */
  UNPINNED = 'UNPINNED',
  /**
   * An unpin was requested but at least one provider still holds the pin (its `unpin()`
   * failed). The content is retained and `DELETE` can be retried; only the providers still
   * holding the pin are contacted again. The re-pin worker leaves these records alone.
   */
  UNPINNING = 'UNPINNING',
}

export enum ProviderPinStatus {
  PINNED = 'PINNED',
  FAILED = 'FAILED',
  UNPINNED = 'UNPINNED',
}

/** Webhook events emitted by the pinning service and re-pin worker. */
export const IPFS_EVENTS = {
  PIN_CREATED: 'ipfs.pin.created',
  PIN_DEGRADED: 'ipfs.pin.degraded',
  PIN_RESTORED: 'ipfs.pin.restored',
  PIN_LOST: 'ipfs.pin.lost',
  PIN_FAILED: 'ipfs.pin.failed',
  PIN_REMOVED: 'ipfs.pin.removed',
} as const;

/**
 * Maximum length of a base64-encoded payload accepted for pinning: 10 MB decoded is ~13.6 MB
 * encoded (base64 adds ~33%), rounded up to a whole number of 4-character groups. Shared by
 * every endpoint that accepts base64 content so they cannot drift apart.
 */
export const MAX_BASE64_CONTENT_LENGTH = 14_316_560;

export const DEFAULT_REPLICATION_FACTOR = 2;
export const DEFAULT_REPIN_INTERVAL_MS = 5 * 60 * 1000;

export interface ProviderPinRecord {
  provider: PinProviderName;
  status: ProviderPinStatus;
  attempts: number;
  pinnedAt?: string;
  lastVerifiedAt?: string;
  lastError?: string;
}

export interface PinRecord {
  cid: string;
  size: number;
  filename?: string;
  replicationFactor: number;
  status: PinStatus;
  providers: ProviderPinRecord[];
  createdAt: string;
  updatedAt: string;
}
