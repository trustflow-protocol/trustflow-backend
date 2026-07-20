import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { rpc as SorobanRpc } from '@stellar/stellar-sdk';
import { LedgerCursorService, LedgerCheckpoint } from './ledger-cursor.service';
import { EventProcessorService, SorobanEvent, ProcessedEvent } from './event-processor.service';
import { STELLAR_CONFIG } from '../stellar/stellar.config';

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
    const processedEvents: ProcessedEvent[] = [];

    for (const event of events) {
      const result = await this.eventProcessorService.processEvent(event);
      processedEvents.push(result);
    }

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
    const processedEvents: ProcessedEvent[] = [];

    for (const event of events) {
      const result = await this.eventProcessorService.processEvent(event);
      processedEvents.push(result);
    }

    const networkHash = await this.getNetworkHash();
    await this.ledgerCursorService.updateCursor(
      contractId,
      ledger,
      `single-${ledger}`,
      networkHash,
    );

    return processedEvents;
  }

  private async fetchEvents(
    contractId: string,
    startLedger: number,
    endLedger: number,
  ): Promise<SorobanEvent[]> {
    try {
      const allEvents: SorobanEvent[] = [];
      let currentStart = startLedger;

      while (currentStart <= endLedger) {
        const batchEnd = Math.min(currentStart + 99, endLedger);
        const response = await this.rpcServer.getEvents({
          startLedger: currentStart,
          filters: [
            {
              type: 'contract',
              contractIds: [contractId],
            },
          ],
          limit: 100,
        });

        allEvents.push(...response.events.map(event => this.parseEvent(event)));
        currentStart = batchEnd + 1;
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
      const event: SorobanEvent = {
        id: failedEvent.eventId,
        ledger: failedEvent.ledger,
        contractId: STELLAR_CONFIG.contractId,
        eventType: 'retry',
        topic: [],
        value: {},
        xdr: '',
        createdAt: new Date(),
      };

      const result = await this.eventProcessorService.processEvent(event);
      results.push(result);
    }

    return results;
  }
}
