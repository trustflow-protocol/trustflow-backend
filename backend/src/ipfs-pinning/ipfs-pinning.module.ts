import { Module } from '@nestjs/common';
import { WebhookModule } from '../webhook/webhook.module';
import { IpfsPinningService } from './ipfs-pinning.service';
import { RepinWorkerService } from './repin-worker.service';
import { IpfsPinningController } from './ipfs-pinning.controller';
import { PIN_PROVIDERS } from './providers/ipfs-provider.interface';
import { PinataProvider } from './providers/pinata.provider';
import { Web3StorageProvider } from './providers/web3-storage.provider';
import { InfuraProvider } from './providers/infura.provider';
import { MonitoringModule } from '../monitoring/monitoring.module';

@Module({
  imports: [WebhookModule, MonitoringModule],
  controllers: [IpfsPinningController],
  providers: [
    IpfsPinningService,
    RepinWorkerService,
    PinataProvider,
    Web3StorageProvider,
    InfuraProvider,
    {
      // Registration order is failover priority order.
      provide: PIN_PROVIDERS,
      useFactory: (
        pinata: PinataProvider,
        web3Storage: Web3StorageProvider,
        infura: InfuraProvider,
      ) => [pinata, web3Storage, infura],
      inject: [PinataProvider, Web3StorageProvider, InfuraProvider],
    },
  ],
  exports: [IpfsPinningService],
})
export class IpfsPinningModule {}
