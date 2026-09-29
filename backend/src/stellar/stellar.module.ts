import { Module } from '@nestjs/common';
import { StellarService } from './stellar.service';
import { RpcFailoverService } from './rpc-failover.service';
import { PlatformBalanceService } from './platform-balance.service';
import { RpcStatusController } from './rpc-status.controller';
import { StellarController } from './stellar.controller';
import { WebhookModule } from '../webhook/webhook.module';

@Module({
  imports: [WebhookModule],
  controllers: [RpcStatusController, StellarController],
  providers: [StellarService, RpcFailoverService, PlatformBalanceService],
  exports: [StellarService, RpcFailoverService],
})
export class StellarModule {}
