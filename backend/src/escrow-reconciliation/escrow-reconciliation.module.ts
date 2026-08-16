import { Module } from '@nestjs/common';
import { EscrowModule } from '../escrow/escrow.module';
import { WebhookModule } from '../webhook/webhook.module';
import { EscrowReconciliationController } from './escrow-reconciliation.controller';
import { EscrowReconciliationService } from './escrow-reconciliation.service';
import { EscrowReconciliationWorkerService } from './escrow-reconciliation-worker.service';
import { EscrowReconciliationStateStore } from './escrow-reconciliation-state.store';
import { EscrowChainStateClient } from './escrow-chain-state.client';
import { SorobanEscrowChainStateClient } from './soroban-escrow-chain-state.client';

@Module({
  imports: [EscrowModule, WebhookModule],
  controllers: [EscrowReconciliationController],
  providers: [
    EscrowReconciliationService,
    EscrowReconciliationWorkerService,
    EscrowReconciliationStateStore,
    SorobanEscrowChainStateClient,
    { provide: EscrowChainStateClient, useClass: SorobanEscrowChainStateClient },
  ],
  exports: [EscrowReconciliationService],
})
export class EscrowReconciliationModule {}
