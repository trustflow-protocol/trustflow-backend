import { Module } from '@nestjs/common';
import { StellarService } from './stellar.service';
import { RpcFailoverService } from './rpc-failover.service';
import { RpcStatusController } from './rpc-status.controller';
import { StellarController } from './stellar.controller';

@Module({
  controllers: [RpcStatusController, StellarController],
  providers: [StellarService, RpcFailoverService],
  exports: [StellarService, RpcFailoverService],
})
export class StellarModule {}
