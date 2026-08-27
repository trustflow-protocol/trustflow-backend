import { Module } from '@nestjs/common';
import { MigrationRegistryService, MIGRATION_DEFINITIONS } from './migration-registry.service';
import { MigrationRunnerService } from './migration-runner.service';
import { MigrationStateStore } from './migration-state.store';
import { MigrationStartupService } from './migration-startup.service';
import { MigrationController } from './migration.controller';
import {
  GigsPriorityBackfillMigration,
  GigRow,
} from './migrations/gigs-priority-backfill.migration';

const GIGS_SEED_ROWS: GigRow[] = [
  { id: 'gig-001', title: 'Smart contract security audit', budgetXLM: '500', urgent: true },
  { id: 'gig-002', title: 'Landing page redesign', budgetXLM: '150', urgent: false },
  { id: 'gig-003', title: 'Stellar anchor integration', budgetXLM: '900', urgent: true },
];

@Module({
  controllers: [MigrationController],
  providers: [
    MigrationRunnerService,
    MigrationRegistryService,
    MigrationStateStore,
    MigrationStartupService,
    {
      provide: GigsPriorityBackfillMigration,
      useFactory: () => new GigsPriorityBackfillMigration(GIGS_SEED_ROWS),
    },
    {
      provide: MIGRATION_DEFINITIONS,
      useFactory: (gigsMigration: GigsPriorityBackfillMigration) => [gigsMigration],
      inject: [GigsPriorityBackfillMigration],
    },
  ],
  exports: [MigrationRunnerService, MigrationRegistryService],
})
export class MigrationModule {}
