import { Inject, Injectable, Optional } from '@nestjs/common';
import { Redis } from 'ioredis';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { MilestoneNotificationsGateway } from '../milestone-notifications/milestone-notifications.gateway';

/** Redis set of the notification ids a wallet has read: `notifications:read:<address>`. */
export const READ_STATE_KEY_PREFIX = 'notifications:read:';

export interface NotificationReadState {
  read: string[];
  unread: string[];
}

export interface MarkReadResult {
  /** The ids the request named, de-duplicated, all of which are now read. */
  notificationIds: string[];
  /** The subset that was still unread before this request. */
  newlyRead: string[];
}

/**
 * In-app notification read/unread state, keyed by wallet rather than by connection (#943).
 *
 * Every lookup reads the shared store fresh, so a notification marked read on one device shows
 * as read to every other session of the same wallet on its next fetch, on any replica. A change
 * is also pushed live to those sessions as `notification:read` through
 * {@link MilestoneNotificationsGateway}.
 *
 * With Redis the read ids live in one set per wallet. Without Redis (local development, or a
 * Redis error) they fall back to process memory, which is still per wallet but only shared by
 * sessions connected to this process.
 */
@Injectable()
export class NotificationReadStateService {
  private readonly logger = new SanitizedLogger(NotificationReadStateService.name);
  private readonly inMemory = new Map<string, Set<string>>();

  constructor(
    @Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
    @Optional() private readonly gateway?: MilestoneNotificationsGateway,
  ) {}

  /** Marks the ids read for this wallet and tells the wallet's other sessions. */
  async markRead(address: string, notificationIds: string[]): Promise<MarkReadResult> {
    const ids = uniqueIds(notificationIds);
    if (ids.length === 0) return { notificationIds: [], newlyRead: [] };

    const alreadyRead = await this.loadReadIds(address);
    await this.saveReadIds(address, ids);
    const newlyRead = ids.filter(id => !alreadyRead.has(id));

    // Broadcast every id, not only the newly read ones: marking read is idempotent, and a session
    // that missed an earlier event catches up on this one.
    try {
      await this.gateway?.broadcastNotificationRead(address, ids);
    } catch (err) {
      // The mark is stored either way; other sessions see it on their next fetch.
      this.logger.warn(
        `Failed to broadcast read-state change: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return { notificationIds: ids, newlyRead };
  }

  /** Splits the ids into read and unread for this wallet, from the shared store, never a cache. */
  async getReadState(address: string, notificationIds: string[]): Promise<NotificationReadState> {
    const ids = uniqueIds(notificationIds);
    const readIds = await this.loadReadIds(address);
    return {
      read: ids.filter(id => readIds.has(id)),
      unread: ids.filter(id => !readIds.has(id)),
    };
  }

  private key(address: string): string {
    return `${READ_STATE_KEY_PREFIX}${address}`;
  }

  private async loadReadIds(address: string): Promise<Set<string>> {
    if (this.redis) {
      try {
        return new Set(await this.redis.smembers(this.key(address)));
      } catch (err) {
        this.logger.warn(
          `Redis read-state lookup failed, using in-memory state: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return new Set(this.inMemory.get(address) ?? []);
  }

  private async saveReadIds(address: string, ids: string[]): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.sadd(this.key(address), ...ids);
        return;
      } catch (err) {
        this.logger.warn(
          `Redis read-state write failed, using in-memory state: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    const read = this.inMemory.get(address) ?? new Set<string>();
    for (const id of ids) read.add(id);
    this.inMemory.set(address, read);
  }
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.map(id => id.trim()).filter(Boolean))];
}
