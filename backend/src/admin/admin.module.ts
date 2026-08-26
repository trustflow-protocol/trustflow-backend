import { Module } from '@nestjs/common';
import { EscrowModule } from '../escrow/escrow.module';
import { GigModule } from '../gig/gig.module';
import { DisputeModule } from '../dispute/dispute.module';
import { ReputationModule } from '../reputation/reputation.module';
import { MigrationModule } from '../migration/migration.module';
import { EscrowReconciliationModule } from '../escrow-reconciliation/escrow-reconciliation.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminGuard } from './admin.guard';

@Module({
  imports: [
    EscrowModule,
    GigModule,
    DisputeModule,
    ReputationModule,
    MigrationModule,
    EscrowReconciliationModule,
  ],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard],
})
export class AdminModule {}
