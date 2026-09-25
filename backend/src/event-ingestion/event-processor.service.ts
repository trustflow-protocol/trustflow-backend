import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { MetricsService } from '../monitoring/metrics.service';
import { EscrowService } from '../escrow/escrow.service';

export interface SorobanEvent {
  id: string;
  ledger: number;
  contractId: string;
  eventType: string;
  topic: string[];
  /** Raw decoded XDR value — type depends on event schema; callers narrow before use. */
  value: Record<string, unknown>;
  xdr: string;
  createdAt: Date;
}

export interface ProcessedEvent {
  eventId: string;
  ledger: number;
  success: boolean;
  error?: string;
  processedAt: Date;
  // Store original event data for retry
  originalEvent?: SorobanEvent;
}

const EVENT_KEY_PREFIX = 'processed-event:';
const EVENTS_INDEX_KEY = 'processed-events:index';

/** Emitted (see `GET /metrics`) every time a call falls back to the in-memory store. */
export const EVENT_PROCESSOR_PERSISTENCE_FALLBACK_METRIC =
  'event_processor_persistence_fallback_total';

/**
 * Reorg-safety dedup log gating whether a Soroban event has already been processed. Backed by
 * Redis so it survives restarts and is shared across instances — see
 * PERSISTENT_STORAGE_SPIKE.md and its "Follow-up decisions" addendum (#190). Losing this log on
 * restart previously risked double-processing events ingested just before the restart; a value
 * round-tripped through Redis is byte-for-byte the same value that used to live in the Map, so
 * reorg-safety semantics are otherwise unaffected by this migration.
 *
 * Falls back to a process-local Map when Redis is unavailable, logged at `error` level and
 * counted via `EVENT_PROCESSOR_PERSISTENCE_FALLBACK_METRIC`.
 */
@Injectable()
export class EventProcessorService implements OnModuleInit {
  private readonly logger = new Logger(EventProcessorService.name);
  /** Fallback store, only used while Redis is unavailable. */
  private processedEvents: Map<string, ProcessedEvent> = new Map();

  constructor(
    private readonly escrowService: EscrowService,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null = null,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  onModuleInit(): void {
    if (!this.redis && process.env.NODE_ENV === 'production') {
      throw new Error(
        'EventProcessorService requires REDIS_URL to be configured in production — refusing ' +
          'to start with per-instance in-memory storage, which would silently diverge across instances.',
      );
    }
  }

  async processEvent(event: SorobanEvent): Promise<ProcessedEvent> {
    const eventId = `${event.ledger}-${event.id}`;

    const existing = await this.tryGet(eventId);
    if (existing) {
      this.logger.warn(`Event ${eventId} already processed, skipping`);
      return existing;
    }

    try {
      await this.applyEvent(event);

      const result: ProcessedEvent = {
        eventId,
        ledger: event.ledger,
        success: true,
        processedAt: new Date(),
        originalEvent: event,
      };

      await this.persist(result);
      this.logger.log(`Event ${eventId} processed successfully`);
      return result;
    } catch (error) {
      const result: ProcessedEvent = {
        eventId,
        ledger: event.ledger,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        processedAt: new Date(),
        originalEvent: event,
      };

      await this.persist(result);
      this.logger.error(`Event ${eventId} failed: ${result.error}`);
      return result;
    }
  }

  private async applyEvent(event: SorobanEvent): Promise<void> {
    switch (event.eventType) {
      case 'escrow_created':
        await this.handleEscrowCreated(event);
        break;
      case 'escrow_funded':
        await this.handleEscrowFunded(event);
        break;
      case 'escrow_released':
        await this.handleEscrowReleased(event);
        break;
      case 'escrow_disputed':
        await this.handleEscrowDisputed(event);
        break;
      default:
        this.logger.warn(`Unknown event type: ${event.eventType}`);
    }
  }

  private async handleEscrowCreated(event: SorobanEvent): Promise<void> {
    const { depositor, beneficiary, amount } = event.value as {
      depositor: string;
      beneficiary: string;
      amount: string;
    };
    await this.escrowService.create(depositor, beneficiary, amount);
    this.logger.log(`Escrow created: ${event.id}`);
  }

  private async handleEscrowFunded(event: SorobanEvent): Promise<void> {
    const escrowId = event.topic[1];
    await this.escrowService.fund(escrowId);
    this.logger.log(`Escrow funded: ${escrowId}`);
  }

  private async handleEscrowReleased(event: SorobanEvent): Promise<void> {
    const escrowId = event.topic[1];
    await this.escrowService.release(escrowId);
    this.logger.log(`Escrow released: ${escrowId}`);
  }

  private async handleEscrowDisputed(event: SorobanEvent): Promise<void> {
    const escrowId = event.topic[1];
    const reason = event.value.reason as string | undefined;
    await this.escrowService.raiseDispute(escrowId, reason);
    this.logger.log(`Escrow disputed: ${escrowId}`);
  }

  async isEventProcessed(eventId: string): Promise<boolean> {
    return (await this.tryGet(eventId)) !== undefined;
  }

  async getProcessedEventsByLedger(ledger: number): Promise<ProcessedEvent[]> {
    return (await this.fetchAll()).filter(e => e.ledger === ledger);
  }

  async getFailedEvents(): Promise<ProcessedEvent[]> {
    return (await this.fetchAll()).filter(e => !e.success);
  }

  async clearEventsBeforeLedger(ledger: number): Promise<number> {
    const all = await this.fetchAll();
    const toClear = all.filter(e => e.ledger < ledger);
    if (toClear.length === 0) return 0;

    if (this.redis) {
      try {
        await this.redis
          .multi()
          .del(...toClear.map(e => this.eventKey(e.eventId)))
          .srem(EVENTS_INDEX_KEY, ...toClear.map(e => e.eventId))
          .exec();
        return toClear.length;
      } catch (err) {
        this.logFallback('clearEventsBeforeLedger', err);
      }
    }

    for (const event of toClear) {
      this.processedEvents.delete(event.eventId);
    }
    return toClear.length;
  }

  // ─── Persistence helpers ────────────────────────────────────────────

  private async persist(result: ProcessedEvent): Promise<void> {
    if (this.redis) {
      try {
        const results = await this.redis
          .multi()
          .set(this.eventKey(result.eventId), JSON.stringify(result))
          .sadd(EVENTS_INDEX_KEY, result.eventId)
          .exec();
        this.assertTransactionOk(results);
        return;
      } catch (err) {
        this.logFallback('persist', err);
      }
    }

    this.processedEvents.set(result.eventId, result);
  }

  private async tryGet(eventId: string): Promise<ProcessedEvent | undefined> {
    if (this.redis) {
      try {
        const raw = await this.redis.get(this.eventKey(eventId));
        return raw ? (JSON.parse(raw) as ProcessedEvent) : undefined;
      } catch (err) {
        this.logFallback('isEventProcessed', err);
      }
    }

    return this.processedEvents.get(eventId);
  }

  private async fetchAll(): Promise<ProcessedEvent[]> {
    if (this.redis) {
      try {
        const ids = await this.redis.smembers(EVENTS_INDEX_KEY);
        if (ids.length === 0) return [];
        const raw = await this.redis.mget(...ids.map(id => this.eventKey(id)));
        return raw.filter((r): r is string => r !== null).map(r => JSON.parse(r) as ProcessedEvent);
      } catch (err) {
        this.logFallback('fetchAll', err);
      }
    }

    return [...this.processedEvents.values()];
  }

  private assertTransactionOk(results: Array<[Error | null, unknown]> | null): void {
    if (!results) {
      throw new Error('Redis transaction aborted (exec() returned null, e.g. a WATCH conflict)');
    }
    const failed = results.find(([err]) => err);
    if (failed) {
      throw new Error(`Redis transaction command failed: ${failed[0]!.message}`);
    }
  }

  private eventKey(eventId: string): string {
    return `${EVENT_KEY_PREFIX}${eventId}`;
  }

  private logFallback(operation: string, err: unknown): void {
    this.metrics?.increment(EVENT_PROCESSOR_PERSISTENCE_FALLBACK_METRIC, { operation });
    this.logger.error(
      `Redis unavailable for eventProcessor.${operation}, falling back to per-instance memory ` +
        '(multi-instance state will diverge until Redis recovers)',
      err instanceof Error ? err.stack : String(err),
    );
  }
}
