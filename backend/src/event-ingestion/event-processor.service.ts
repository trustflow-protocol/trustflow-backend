import { Injectable, Logger } from '@nestjs/common';
import { EscrowService } from '../escrow/escrow.service';

export interface SorobanEvent {
  id: string;
  ledger: number;
  contractId: string;
  eventType: string;
  topic: string[];
  value: any;
  xdr: string;
  createdAt: Date;
}

export interface ProcessedEvent {
  eventId: string;
  ledger: number;
  success: boolean;
  error?: string;
  processedAt: Date;
}

@Injectable()
export class EventProcessorService {
  private readonly logger = new Logger(EventProcessorService.name);
  private processedEvents: Map<string, ProcessedEvent> = new Map();

  constructor(private readonly escrowService: EscrowService) {}

  async processEvent(event: SorobanEvent): Promise<ProcessedEvent> {
    const eventId = `${event.ledger}-${event.id}`;

    if (this.processedEvents.has(eventId)) {
      this.logger.warn(`Event ${eventId} already processed, skipping`);
      return this.processedEvents.get(eventId)!;
    }

    try {
      await this.applyEvent(event);

      const result: ProcessedEvent = {
        eventId,
        ledger: event.ledger,
        success: true,
        processedAt: new Date(),
      };

      this.processedEvents.set(eventId, result);
      this.logger.log(`Event ${eventId} processed successfully`);
      return result;
    } catch (error) {
      const result: ProcessedEvent = {
        eventId,
        ledger: event.ledger,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        processedAt: new Date(),
      };

      this.processedEvents.set(eventId, result);
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
    const { depositor, beneficiary, amount } = event.value;
    await this.escrowService.create(depositor, beneficiary, amount);
    this.logger.log(`Escrow created: ${event.id}`);
  }

  private async handleEscrowFunded(event: SorobanEvent): Promise<void> {
    const escrowId = event.topic[1];
    const escrow = await this.escrowService.findById(escrowId);
    if (escrow) {
      escrow.status = 'active';
      this.logger.log(`Escrow funded: ${escrowId}`);
    }
  }

  private async handleEscrowReleased(event: SorobanEvent): Promise<void> {
    const escrowId = event.topic[1];
    await this.escrowService.release(escrowId);
    this.logger.log(`Escrow released: ${escrowId}`);
  }

  private async handleEscrowDisputed(event: SorobanEvent): Promise<void> {
    const escrowId = event.topic[1];
    const reason = event.value.reason;
    await this.escrowService.raiseDispute(escrowId, reason);
    this.logger.log(`Escrow disputed: ${escrowId}`);
  }

  async isEventProcessed(eventId: string): Promise<boolean> {
    return this.processedEvents.has(eventId);
  }

  async getProcessedEventsByLedger(ledger: number): Promise<ProcessedEvent[]> {
    return [...this.processedEvents.values()].filter(e => e.ledger === ledger);
  }

  async getFailedEvents(): Promise<ProcessedEvent[]> {
    return [...this.processedEvents.values()].filter(e => !e.success);
  }

  async clearEventsBeforeLedger(ledger: number): Promise<number> {
    let cleared = 0;
    for (const [key, value] of this.processedEvents.entries()) {
      if (value.ledger < ledger) {
        this.processedEvents.delete(key);
        cleared++;
      }
    }
    return cleared;
  }
}
