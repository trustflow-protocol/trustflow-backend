import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { rpc as SorobanRpc } from '@stellar/stellar-sdk';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { STELLAR_CONFIG } from '../stellar/stellar.config';

export interface IndexedSorobanEvent {
  eventId: string;
  ledger: number;
  contractId: string;
  eventType: string;
  topic: string[];
  value: unknown;
  xdr: string;
  indexedAt: string;
}

const EVENT_KEY_PREFIX = 'soroban:event:';
const EVENTS_INDEX_KEY = 'soroban:events:index';
const CURSOR_KEY = 'soroban:event-indexer:cursor';

@Injectable()
export class SorobanEventIndexerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SorobanEventIndexerService.name);
  private rpcServer!: SorobanRpc.Server;
  private pollingInterval: NodeJS.Timeout | null = null;
  private isRunning = false;

  private readonly POLL_INTERVAL_MS = 10_000;
  private readonly MAX_LEDGER_RANGE = 100;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
  ) {}

  onModuleInit() {
    this.rpcServer = new SorobanRpc.Server(STELLAR_CONFIG.sorobanRpcUrl);
  }

  onModuleDestroy() {
    this.stop();
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;

    const run = async () => {
      try {
        await this.poll();
      } catch (err) {
        this.logger.error('Soroban event poll failed', err);
      }
    };

    void run();
    this.pollingInterval = setInterval(() => void run(), this.POLL_INTERVAL_MS);
    this.logger.log('Soroban event indexer started');
  }

  stop() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    this.isRunning = false;
  }

  async poll(): Promise<IndexedSorobanEvent[]> {
    const contractId = STELLAR_CONFIG.contractId;
    if (!contractId) {
      this.logger.warn('No TRUSTFLOW_CONTRACT_ID configured, skipping poll');
      return [];
    }

    const cursor = await this.getCursor();
    const currentLedger = await this.getCurrentLedger();
    const startLedger = cursor + 1;
    const endLedger = Math.min(currentLedger, startLedger + this.MAX_LEDGER_RANGE - 1);

    if (startLedger > endLedger) return [];

    const response = await this.rpcServer.getEvents({
      startLedger,
      filters: [{ type: 'contract', contractIds: [contractId] }],
      limit: 100,
    });

    const events: IndexedSorobanEvent[] = [];
    for (const raw of response.events) {
      const event: IndexedSorobanEvent = {
        eventId: raw.id,
        ledger: raw.ledger,
        contractId: raw.contractId?.toString() || contractId,
        eventType: this.parseTopic(raw.topic[0]),
        topic: raw.topic.map(t => this.parseTopic(t)),
        value: this.parseValue(raw.value),
        xdr: raw.value.toXDR().toString(),
        indexedAt: new Date().toISOString(),
      };
      events.push(event);
      await this.storeEvent(event);
    }

    await this.setCursor(endLedger);

    if (events.length > 0) {
      this.logger.log(`Indexed ${events.length} events from ledgers ${startLedger}-${endLedger}`);
    }

    return events;
  }

  async getEvents(limit = 50): Promise<IndexedSorobanEvent[]> {
    if (this.redis) {
      try {
        const ids = await this.redis.zrevrange(EVENTS_INDEX_KEY, 0, limit - 1);
        if (ids.length === 0) return [];
        const raw = await this.redis.mget(...ids.map(id => `${EVENT_KEY_PREFIX}${id}`));
        return raw.filter((r): r is string => r !== null).map(r => JSON.parse(r));
      } catch {
        // fall through
      }
    }
    return [];
  }

  private async storeEvent(event: IndexedSorobanEvent): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis
        .multi()
        .set(`${EVENT_KEY_PREFIX}${event.eventId}`, JSON.stringify(event))
        .zadd(EVENTS_INDEX_KEY, event.ledger, event.eventId)
        .exec();
    } catch (err) {
      this.logger.warn('Failed to store event in Redis', err);
    }
  }

  private async getCursor(): Promise<number> {
    if (this.redis) {
      try {
        const raw = await this.redis.get(CURSOR_KEY);
        return raw ? parseInt(raw, 10) : 0;
      } catch {
        // fall through
      }
    }
    return 0;
  }

  private async setCursor(ledger: number): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.set(CURSOR_KEY, ledger.toString());
    } catch {
      // best effort
    }
  }

  private async getCurrentLedger(): Promise<number> {
    const res = await this.rpcServer.getHealth();
    if (res && typeof res === 'object' && 'latest_ledger' in res) {
      return (res as { latest_ledger: number }).latest_ledger;
    }
    return 0;
  }

  private parseTopic(topic: unknown): string {
    try {
      const t = topic as { switch?: () => { name: string }; sym?: () => { toString(): string }; bytes?: () => Uint8Array };
      if (t?.switch?.().name === 'SCV_SYMBOL') return t.sym!().toString();
      if (t?.switch?.().name === 'SCV_BYTES') return Buffer.from(t.bytes!()).toString();
      return String(topic);
    } catch {
      return 'unknown';
    }
  }

  private parseValue(value: unknown): unknown {
    try {
      const v = value as { switch?: () => { name: string }; bytes?: () => Uint8Array };
      if (v?.switch?.().name === 'SCV_BYTES') {
        return JSON.parse(Buffer.from(v.bytes!()).toString());
      }
      return String(value);
    } catch {
      return String(value);
    }
  }
}
