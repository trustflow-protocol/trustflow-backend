import { Injectable, OnModuleInit } from '@nestjs/common';
import { OutboxEventDispatcher } from '../outbox/outbox-event-dispatcher.service';
import { OutboxEvent } from '../outbox/outbox.types';
import { ESCROW_EVENTS, Escrow } from './escrow.service';
import { ReputationService } from '../reputation/reputation.service';

@Injectable()
export class EscrowEventsConsumer implements OnModuleInit {
  constructor(
    private readonly dispatcher: OutboxEventDispatcher,
    private readonly reputationService: ReputationService,
  ) {}

  onModuleInit() {
    this.dispatcher.register('escrow.*', event => this.handleEscrowEvent(event));
  }

  private async handleEscrowEvent(event: OutboxEvent): Promise<void> {
    const escrow = event.payload as Escrow;

    // `escrow.disputed` no longer sends Discord here: the dispute saga sends
    // it exactly once per dispute, from every entry point (#636).

    if (
      event.type === ESCROW_EVENTS.ESCROW_RELEASED ||
      event.type === ESCROW_EVENTS.ESCROW_CANCELLED ||
      event.type === ESCROW_EVENTS.ESCROW_SPLIT
    ) {
      if (escrow.disputedAt) {
        let depositorOutcome: 'won' | 'lost' | 'split' = 'split';
        let beneficiaryOutcome: 'won' | 'lost' | 'split' = 'split';

        if (event.type === ESCROW_EVENTS.ESCROW_RELEASED && !escrow.splitPercentage) {
          beneficiaryOutcome = 'won';
          depositorOutcome = 'lost';
        } else if (event.type === ESCROW_EVENTS.ESCROW_CANCELLED) {
          depositorOutcome = 'won';
          beneficiaryOutcome = 'lost';
        } else if (event.type === ESCROW_EVENTS.ESCROW_SPLIT || escrow.splitPercentage) {
          depositorOutcome = 'split';
          beneficiaryOutcome = 'split';
        }

        await this.reputationService.recordDisputeResolved(
          escrow,
          depositorOutcome,
          beneficiaryOutcome,
        );
      } else if (event.type === ESCROW_EVENTS.ESCROW_RELEASED) {
        await this.reputationService.recordEscrowCompleted(escrow);
      }
    }
  }
}
