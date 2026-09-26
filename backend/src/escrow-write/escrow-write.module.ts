import { Module } from '@nestjs/common';
import { rpc as SorobanRpc } from '@stellar/stellar-sdk';
import {
  EscrowReleaseTransactionBuilderService,
  SOROBAN_RPC_SERVER,
  ESCROW_WRITE_STELLAR_CONFIG,
} from './escrow-release-transaction-builder.service';
import { getStellarConfig } from '../stellar/stellar.config';

@Module({
  providers: [
    EscrowReleaseTransactionBuilderService,
    {
      provide: SOROBAN_RPC_SERVER,
      useFactory: () => new SorobanRpc.Server(getStellarConfig().sorobanRpcUrl),
    },
    { provide: ESCROW_WRITE_STELLAR_CONFIG, useFactory: () => getStellarConfig() },
  ],
  exports: [EscrowReleaseTransactionBuilderService],
})
export class EscrowWriteModule {}
