import { Module } from '@nestjs/common';
import {
  EscrowReleaseTransactionBuilderService,
  SOROBAN_RPC_SERVER,
  ESCROW_WRITE_STELLAR_CONFIG,
} from './escrow-release-transaction-builder.service';
import { getStellarConfig } from '../stellar/stellar.config';
import { buildSorobanServer } from '../stellar/soroban.helper';

@Module({
  providers: [
    EscrowReleaseTransactionBuilderService,
    {
      provide: SOROBAN_RPC_SERVER,
      useFactory: () => buildSorobanServer(getStellarConfig().sorobanRpcUrl),
    },
    { provide: ESCROW_WRITE_STELLAR_CONFIG, useFactory: () => getStellarConfig() },
  ],
  exports: [EscrowReleaseTransactionBuilderService],
})
export class EscrowWriteModule {}
