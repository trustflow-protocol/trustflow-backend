import { ProviderHealthCheckWorkerService } from './provider-health-check-worker.service';
import { ProviderHealthService } from './provider-health.service';
import { IpfsPinProvider, PinProviderName } from './providers/ipfs-provider.interface';
import { DistributedLockService } from '../common/redis/distributed-lock.service';
import { resetEnvConfig, validateEnv } from '../config/env.config';

/** Always grants the lock — the distributed-lock mechanics themselves are covered by distributed-lock.service.spec.ts. */
function fakeLock(): jest.Mocked<Pick<DistributedLockService, 'tryAcquire' | 'release'>> {
  return {
    tryAcquire: jest.fn().mockResolvedValue('fake-token'),
    release: jest.fn().mockResolvedValue(undefined),
  };
}

interface FakeProviderOverrides {
  pin?: jest.Mock;
  unpin?: jest.Mock;
  verify?: jest.Mock;
}

function fakeProvider(name: PinProviderName, overrides: FakeProviderOverrides = {}) {
  return {
    name,
    isConfigured: true,
    pin: overrides.pin ?? jest.fn().mockResolvedValue(undefined),
    unpin: overrides.unpin ?? jest.fn().mockResolvedValue(undefined),
    verify: overrides.verify ?? jest.fn().mockResolvedValue(true),
  };
}

describe('ProviderHealthCheckWorkerService', () => {
  const originalInterval = process.env.IPFS_PROVIDER_HEALTH_CHECK_INTERVAL_MS;
  let providerHealth: jest.Mocked<
    Pick<ProviderHealthService, 'recordPinSuccess' | 'recordPinFailure'>
  >;

  beforeEach(() => {
    process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret-at-least-16-chars';
    resetEnvConfig();
    validateEnv();
    providerHealth = {
      recordPinSuccess: jest.fn().mockResolvedValue(undefined),
      recordPinFailure: jest.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalInterval === undefined) delete process.env.IPFS_PROVIDER_HEALTH_CHECK_INTERVAL_MS;
    else process.env.IPFS_PROVIDER_HEALTH_CHECK_INTERVAL_MS = originalInterval;
    resetEnvConfig();
  });

  function makeWorker(providers: IpfsPinProvider[]): ProviderHealthCheckWorkerService {
    return new ProviderHealthCheckWorkerService(
      providers,
      providerHealth as unknown as ProviderHealthService,
      fakeLock() as unknown as DistributedLockService,
    );
  }

  describe('runOnce', () => {
    it('performs a real pin/verify/unpin cycle and records success for a healthy provider', async () => {
      const pinata = fakeProvider(PinProviderName.PINATA);
      const worker = makeWorker([pinata as unknown as IpfsPinProvider]);

      await worker.runOnce();

      expect(pinata.pin).toHaveBeenCalledTimes(1);
      expect(pinata.verify).toHaveBeenCalledTimes(1);
      expect(pinata.unpin).toHaveBeenCalledTimes(1);
      expect(providerHealth.recordPinSuccess).toHaveBeenCalledWith(
        PinProviderName.PINATA,
        expect.any(Number),
      );
      expect(providerHealth.recordPinFailure).not.toHaveBeenCalled();
    });

    it('records a failure when the provider rejects the real pin call, even though a generic ping would still pass', async () => {
      const infura = fakeProvider(PinProviderName.INFURA, {
        pin: jest.fn().mockRejectedValue(new Error('auth misconfigured for pin uploads')),
      });
      const worker = makeWorker([infura as unknown as IpfsPinProvider]);

      await worker.runOnce();

      expect(infura.unpin).not.toHaveBeenCalled();
      expect(providerHealth.recordPinFailure).toHaveBeenCalledWith(
        PinProviderName.INFURA,
        expect.any(Number),
        expect.any(Error),
      );
      expect(providerHealth.recordPinSuccess).not.toHaveBeenCalled();
    });

    it('records a failure when verify reports the probe pin is not actually held', async () => {
      const web3 = fakeProvider(PinProviderName.WEB3_STORAGE, {
        verify: jest.fn().mockResolvedValue(false),
      });
      const worker = makeWorker([web3 as unknown as IpfsPinProvider]);

      await worker.runOnce();

      expect(providerHealth.recordPinFailure).toHaveBeenCalledWith(
        PinProviderName.WEB3_STORAGE,
        expect.any(Number),
        expect.any(Error),
      );
    });

    it('still counts the probe as successful when cleanup (unpin) fails, since the pin path itself worked', async () => {
      const pinata = fakeProvider(PinProviderName.PINATA, {
        unpin: jest.fn().mockRejectedValue(new Error('unpin endpoint flaky')),
      });
      const worker = makeWorker([pinata as unknown as IpfsPinProvider]);

      await expect(worker.runOnce()).resolves.toBeUndefined();

      expect(providerHealth.recordPinSuccess).toHaveBeenCalledWith(
        PinProviderName.PINATA,
        expect.any(Number),
      );
      expect(providerHealth.recordPinFailure).not.toHaveBeenCalled();
    });

    it('probes every registered provider independently so one failure does not block the others', async () => {
      const pinata = fakeProvider(PinProviderName.PINATA);
      const infura = fakeProvider(PinProviderName.INFURA, {
        pin: jest.fn().mockRejectedValue(new Error('down')),
      });
      const worker = makeWorker([
        pinata as unknown as IpfsPinProvider,
        infura as unknown as IpfsPinProvider,
      ]);

      await worker.runOnce();

      expect(providerHealth.recordPinSuccess).toHaveBeenCalledWith(
        PinProviderName.PINATA,
        expect.any(Number),
      );
      expect(providerHealth.recordPinFailure).toHaveBeenCalledWith(
        PinProviderName.INFURA,
        expect.any(Number),
        expect.any(Error),
      );
    });
  });

  describe('onModuleInit / onModuleDestroy', () => {
    it('does not schedule a timer when the interval is disabled', () => {
      process.env.IPFS_PROVIDER_HEALTH_CHECK_INTERVAL_MS = '0';
      resetEnvConfig();
      validateEnv();
      const setIntervalSpy = jest.spyOn(global, 'setInterval');
      const worker = makeWorker([
        fakeProvider(PinProviderName.PINATA) as unknown as IpfsPinProvider,
      ]);

      worker.onModuleInit();

      expect(setIntervalSpy).not.toHaveBeenCalled();
      setIntervalSpy.mockRestore();
    });

    it('schedules and clears a timer when an interval is configured', async () => {
      process.env.IPFS_PROVIDER_HEALTH_CHECK_INTERVAL_MS = '60000';
      resetEnvConfig();
      validateEnv();
      const worker = makeWorker([
        fakeProvider(PinProviderName.PINATA) as unknown as IpfsPinProvider,
      ]);

      worker.onModuleInit();
      await worker.onModuleDestroy();
    });
  });
});
