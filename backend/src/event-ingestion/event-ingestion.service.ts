import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { rpc as SorobanRpc } from '@stellar/stellar-sdk';
import { LedgerCursorService, LedgerCheckpoint } from './ledger-cursor.service';
import { EventProcessorService, SorobanEvent, ProcessedEvent } from './event-processor.service';
import { STELLAR_CONFIG } from '../stellar/stellar.config';
import { mapWithConcurrency } from '../common/concurrency';

/** How many independent escrows to process in parallel per ingestion batch (#238). */
const EVENT_PROCESSING_CONCURRENCY = Number(process.env.EVENT_PROCESSING_CONCURRENCY) || 8;

@Injectable()
export class EventIngestionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventIngestionService.name);
  private rpcServer: SorobanRpc.Server;
  private pollingInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private readonly POLL_INTERVAL_MS = 5000;
  private readonly MAX_LEDGER_RANGE = 100;

  constructor(
    private readonly ledgerCursorService: LedgerCursorService,
    private readonly eventProcessorService: EventProcessorService,
  ) {}

  onModuleInit() {
    this.rpcServer = new SorobanRpc.Server(STELLAR_CONFIG.sorobanRpcUrl);
    this.logger.log('EventIngestionService initialized');
  }

  onModuleDestroy() {
    this.stopPolling();
  }

  async startPolling(contractId?: string): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Polling already running');
      return;
    }

    this.isRunning = true;
    this.logger.log('Starting event polling');

    const targetContract = contractId || STELLAR_CONFIG.contractId;

    this.pollingInterval = setInterval(async () => {
      try {
        await this.ingestEvents(targetContract);
      } catch (error) {
        this.logger.error('Error during polling:', error);
      }
    }, this.POLL_INTERVAL_MS);

    await this.ingestEvents(targetContract);
  }

  stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    this.isRunning = false;
    this.logger.log('Event polling stopped');
  }

  async ingestEvents(contractId: string): Promise<ProcessedEvent[]> {
    const checkpoint = await this.ledgerCursorService.getCursor(contractId);
    const currentLedger = await this.getCurrentLedgerSequence();

    const startLedger = checkpoint ? checkpoint.lastProcessedLedger + 1 : 1;
    const endLedger = Math.min(currentLedger, startLedger + this.MAX_LEDGER_RANGE - 1);

    if (startLedger > endLedger) {
      this.logger.debug('No new ledgers to process');
      return [];
    }

    this.logger.log(`Ingesting events from ledger ${startLedger} to ${endLedger}`);

    const events = await this.fetchEvents(contractId, startLedger, endLedger);
    const processedEvents = await this.processEventBatch(events);

    const latestProcessedLedger = events.length > 0 ? events[events.length - 1].ledger : endLedger;
    const networkHash = await this.getNetworkHash();

    await this.ledgerCursorService.updateCursor(
      contractId,
      latestProcessedLedger,
      `${startLedger}-${endLedger}`,
      networkHash,
    );

    return processedEvents;
  }

  async ingestSingleLedger(contractId: string, ledger: number): Promise<ProcessedEvent[]> {
    const events = await this.fetchEvents(contractId, ledger, ledger);
    const processedEvents = await this.processEventBatch(events);

    const networkHash = await this.getNetworkHash();
    await this.ledgerCursorService.updateCursor(
      contractId,
      ledger,
      `single-${ledger}`,
      networkHash,
    );

    return processedEvents;
  }

  /**
   * Process a fetched batch of events with per-escrow ordering preserved and
   * independent escrows processed in parallel (#238).
   *
   * Concurrency-safety analysis:
   *  - `escrow_funded` / `escrow_released` / `escrow_disputed` carry the
   *    escrow id in `topic[1]`. Events with the *same* `topic[1]` MUST keep
   *    their relative order (e.g. funded before released), so they are grouped
   *    and each group runs sequentially.
   *  - `escrow_created` (and any unknown type) has no `topic[1]`. It cannot be
   *    correlated to a specific later keyed event, and a keyed event may
   *    depend on it (created must precede funded for the same escrow). So all
   *    id-less events run first, strictly in their original order, before any
   *    keyed group starts — no keyed handler can observe a missing escrow.
   *  - Groups for different escrow ids are independent (they touch different
   *    rows), so they run concurrently, bounded by `EVENT_PROCESSING_CONCURRENCY`.
   *  - `processEvent` swallows its own errors (returns `{ success: false }`),
   *    so per-event isolation is unchanged.
   *
   * The returned array is ordered id-less-first then by group; callers use it
   * for counts/status only (the ledger cursor is advanced from `events`, not
   * from this array).
   */
  async processEventBatch(events: SorobanEvent[]): Promise<ProcessedEvent[]> {
    const unkeyed: SorobanEvent[] = [];
    const keyed = new Map<string, SorobanEvent[]>();

    for (const event of events) {
      const key = event.topic[1];
      if (key === undefined || key === '') {
        unkeyed.push(event);
        continue;
      }
      let bucket = keyed.get(key);
      if (!bucket) {
        bucket = [];
        keyed.set(key, bucket);
      }
      bucket.push(event);
    }

    const processed: ProcessedEvent[] = [];

    // Phase 1 — id-less events (escrow_created, unknown), strict original order.
    for (const event of unkeyed) {
      processed.push(await this.eventProcessorService.processEvent(event));
    }

    // Phase 2 — one group per escrow id, groups in parallel, sequential within.
    const groupResults = await mapWithConcurrency(
      [...keyed.values()],
      EVENT_PROCESSING_CONCURRENCY,
      async group => {
        const groupOut: ProcessedEvent[] = [];
        for (const event of group) {
          groupOut.push(await this.eventProcessorService.processEvent(event));
        }
        return groupOut;
      },
    );
    for (const result of groupResults) {
      if (result.status === 'fulfilled') {
        processed.push(...result.value);
      }
    }

    return processed;
  }

  private async fetchEvents(
    contractId: string,
    startLedger: number,
    endLedger: number,
  ): Promise<SorobanEvent[]> {
    try {
      const allEvents: SorobanEvent[] = [];
      let currentStart = startLedger;
      let cursor: string | undefined;

      while (currentStart <= endLedger) {
        const batchEnd = Math.min(currentStart + 99, endLedger);
        
        // Build request parameters — when using cursor, omit startLedger and endLedger
        const getEventsParams: any = {
          filters: [
            {
              type: 'contract',
              contractIds: [contractId],
            },
          ],
          limit: 100,
        };

        if (cursor) {
          // Use cursor-based pagination for the current batch
          getEventsParams.cursor = cursor;
          // When using cursor, endLedger can still be specified to bound the result
          getEventsParams.endLedger = batchEnd + 1; // +1 because endLedger is exclusive
        } else {
          // Start new batch with explicit ledger bounds
          getEventsParams.startLedger = currentStart;
          getEventsParams.endLedger = batchEnd + 1; // +1 because endLedger is exclusive
        }

        const response = await this.rpcServer.getEvents(getEventsParams);
        allEvents.push(...response.events.map(event => this.parseEvent(event)));

        // Check if more events exist in this batch via cursor
        if (response.cursor && response.events.length === 100) {
          // More events exist in this ledger range, continue with cursor
          cursor = response.cursor;
        } else {
          // No more events in this batch, move to next batch
          cursor = undefined;
          currentStart = batchEnd + 1;
        }
      }

      return allEvents.filter(e => e.ledger >= startLedger && e.ledger <= endLedger);
    } catch (error) {
      this.logger.error(`Failed to fetch events for ledgers ${startLedger}-${endLedger}:`, error);
      throw error;
    }
  }

  private parseEvent(event: SorobanRpc.Api.EventResponse): SorobanEvent {
    const parsedValue = this.parseEventValue(event.value);
    const topics = event.topic.map(t => this.parseTopic(t));

    return {
      id: event.id,
      ledger: event.ledger,
      contractId: event.contractId?.toString() || '',
      eventType: topics[0] || 'unknown',
      topic: topics,
      value: parsedValue,
      xdr: event.value.toXDR().toString(),
      createdAt: new Date(),
    };
  }

  private parseEventValue(value: any): any {
    try {
      if (value.switch().name === 'SCV_BYTES') {
        const bytes = value.bytes();
        return JSON.parse(Buffer.from(bytes).toString());
      }
      return value.toXDR();
    } catch {
      return value.toXDR();
    }
  }

  private parseTopic(topic: any): string {
    try {
      if (topic.switch().name === 'SCV_SYMBOL') {
        return topic.sym().toString();
      }
      if (topic.switch().name === 'SCV_BYTES') {
        return Buffer.from(topic.bytes()).toString();
      }
      return topic.toXDR();
    } catch {
      return 'unknown';
    }
  }

  private async getCurrentLedgerSequence(): Promise<number> {
    try {
      const response = await this.rpcServer.getHealth();
      if (response && typeof response === 'object' && 'latest_ledger' in response) {
        return (response as { latest_ledger: number }).latest_ledger;
      }
      return 0;
    } catch (error) {
      this.logger.error('Failed to get current ledger:', error);
      return 0;
    }
  }

  private async getNetworkHash(): Promise<string> {
    try {
      const network = await this.rpcServer.getNetwork();
      return network.passphrase;
    } catch (error) {
      this.logger.error('Failed to get network hash:', error);
      return '';
    }
  }

  async handleReorg(contractId: string, fromLedger: number): Promise<void> {
    this.logger.warn(`Handling reorg from ledger ${fromLedger}`);

    await this.eventProcessorService.clearEventsBeforeLedger(fromLedger);
    await this.ledgerCursorService.updateCursor(
      contractId,
      fromLedger - 1,
      `reorg-${fromLedger}`,
      '',
    );

    this.logger.log(`Reorg handled, reprocessing from ledger ${fromLedger}`);
  }

  async getStatus(): Promise<{
    isRunning: boolean;
    checkpoint?: LedgerCheckpoint;
    failedEvents: number;
  }> {
    const checkpoint = await this.ledgerCursorService.getCursor(STELLAR_CONFIG.contractId);
    const failedEvents = await this.eventProcessorService.getFailedEvents();

    return {
      isRunning: this.isRunning,
      checkpoint,
      failedEvents: failedEvents.length,
    };
  }

  async retryFailedEvents(): Promise<ProcessedEvent[]> {
    const failedEvents = await this.eventProcessorService.getFailedEvents();
    const results: ProcessedEvent[] = [];

    for (const failedEvent of failedEvents) {
      // Use the original event data if available, otherwise skip
      if (!failedEvent.originalEvent) {
        this.logger.warn(
          `Failed event ${failedEvent.eventId} has no original event data, skipping retry`,
        );
        continue;
      }

      // Re-process with the original event data
      const result = await this.eventProcessorService.processEvent(failedEvent.originalEvent);
      results.push(result);
    }

    return results;
  }
}
