import { Module } from '@nestjs/common';
import { StellarService } from './stellar.service';
import { RpcFailoverService } from './rpc-failover.service';
import { RpcStatusController } from './rpc-status.controller';

@Module({
  controllers: [RpcStatusController],
  providers: [StellarService, RpcFailoverService],
  exports: [StellarService, RpcFailoverService],
})
export class StellarModule {}
