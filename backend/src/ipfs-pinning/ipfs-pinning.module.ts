import { Module } from '@nestjs/common';
import { WebhookModule } from '../webhook/webhook.module';
import { CircuitBreakerModule } from '../common/circuit-breaker';
import { IpfsPinningService } from './ipfs-pinning.service';
import { RepinWorkerService } from './repin-worker.service';
import { ProviderHealthCheckWorkerService } from './provider-health-check-worker.service';
import { IpfsPinningController } from './ipfs-pinning.controller';
import { PIN_PROVIDERS } from './providers/ipfs-provider.interface';
import { PinataProvider } from './providers/pinata.provider';
import { InfuraProvider } from './providers/infura.provider';
import { Web3StorageProvider } from './providers/web3-storage.provider';
import { MonitoringModule } from '../monitoring/monitoring.module';
import { ProviderHealthService } from './provider-health.service';

export const PIN_PROVIDER_PRIORITY = ['pinata', 'infura', 'web3.storage'] as const;

/**
 * Sequential provider priority order: Pinata → Infura → Web3.Storage.
 * Order matches PinProviderName enum values: 'pinata', 'infura', 'web3.storage'.
 * Providers are tried in this exact order until replicationFactor successes are achieved.
 */
export const IPFS_PINNING_PERSISTENCE_FALLBACK_METRIC = 'ipfs_pinning_persistence_fallback_total';

/**
 * Emitted every time a provider fails to release a pin during `unpin()`.
 */
export const IPFS_UNPIN_FAILURE_METRIC = 'ipfs_unpin_failure_total';

@Module({
  imports: [WebhookModule, MonitoringModule, CircuitBreakerModule],
  controllers: [IpfsPinningController],
  providers: [
    IpfsPinningService,
    RepinWorkerService,
    ProviderHealthCheckWorkerService,
    ProviderHealthService,
    PinataProvider,
    InfuraProvider,
    Web3StorageProvider,
    {
      // Registration order is failover priority order: Pinata → Infura → Web3Storage.
      provide: PIN_PROVIDERS,
      useFactory: (
        pinata: PinataProvider,
        infura: InfuraProvider,
        web3Storage: Web3StorageProvider,
      ) => [pinata, infura, web3Storage],
      inject: [PinataProvider, InfuraProvider, Web3StorageProvider],
    },
  ],
  exports: [IpfsPinningService, ProviderHealthService],
})
export class IpfsPinningModule {}
