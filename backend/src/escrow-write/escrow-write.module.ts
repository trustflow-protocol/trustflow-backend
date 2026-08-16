import { Module } from '@nestjs/common';
import { rpc as SorobanRpc } from '@stellar/stellar-sdk';
import {
  EscrowReleaseTransactionBuilderService,
  SOROBAN_RPC_SERVER,
  ESCROW_WRITE_STELLAR_CONFIG,
} from './escrow-release-transaction-builder.service';
import { STELLAR_CONFIG } from '../stellar/stellar.config';

@Module({
  providers: [
    EscrowReleaseTransactionBuilderService,
    {
      provide: SOROBAN_RPC_SERVER,
      useFactory: () => new SorobanRpc.Server(STELLAR_CONFIG.sorobanRpcUrl),
    },
    { provide: ESCROW_WRITE_STELLAR_CONFIG, useValue: STELLAR_CONFIG },
  ],
  exports: [EscrowReleaseTransactionBuilderService],
})
export class EscrowWriteModule {}
