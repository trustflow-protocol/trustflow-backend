import { Module } from '@nestjs/common';
import { EscrowReleaseTransactionBuilderService } from './escrow-release-transaction-builder.service';

@Module({
  providers: [EscrowReleaseTransactionBuilderService],
  exports: [EscrowReleaseTransactionBuilderService],
})
export class EscrowWriteModule {}
