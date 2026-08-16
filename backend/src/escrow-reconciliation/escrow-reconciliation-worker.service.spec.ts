import { EscrowReconciliationWorkerService } from './escrow-reconciliation-worker.service';
import { EscrowReconciliationService } from './escrow-reconciliation.service';

describe('EscrowReconciliationWorkerService', () => {
  const originalInterval = process.env.ESCROW_RECONCILIATION_SWEEP_INTERVAL_MS;
  let reconciliationService: jest.Mocked<Pick<EscrowReconciliationService, 'reconcile'>>;
  let worker: EscrowReconciliationWorkerService;

  beforeEach(() => {
    reconciliationService = {
      reconcile: jest.fn().mockResolvedValue({ runId: 'recon-1', driftCount: 0 }),
    };
    worker = new EscrowReconciliationWorkerService(
      reconciliationService as unknown as EscrowReconciliationService,
    );
  });

  afterEach(() => {
    worker.onModuleDestroy();
    jest.useRealTimers();
    if (originalInterval === undefined) delete process.env.ESCROW_RECONCILIATION_SWEEP_INTERVAL_MS;
    else process.env.ESCROW_RECONCILIATION_SWEEP_INTERVAL_MS = originalInterval;
  });

  describe('runOnce', () => {
    it('delegates to the reconciliation service', async () => {
      await worker.runOnce();
      expect(reconciliationService.reconcile).toHaveBeenCalledWith();
    });
  });

  describe('onModuleInit / onModuleDestroy', () => {
    it('schedules periodic sweeps at the default interval', () => {
      jest.useFakeTimers();
      delete process.env.ESCROW_RECONCILIATION_SWEEP_INTERVAL_MS;

      worker.onModuleInit();
      expect(reconciliationService.reconcile).not.toHaveBeenCalled();

      jest.advanceTimersByTime(10 * 60 * 1000);
      return Promise.resolve().then(() => {
        expect(reconciliationService.reconcile).toHaveBeenCalledTimes(1);
      });
    });

    it('honors a custom ESCROW_RECONCILIATION_SWEEP_INTERVAL_MS', () => {
      jest.useFakeTimers();
      process.env.ESCROW_RECONCILIATION_SWEEP_INTERVAL_MS = '1000';

      worker.onModuleInit();
      jest.advanceTimersByTime(999);
      expect(reconciliationService.reconcile).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      return Promise.resolve().then(() => {
        expect(reconciliationService.reconcile).toHaveBeenCalledTimes(1);
      });
    });

    it('does not schedule a sweep when the interval is disabled', () => {
      jest.useFakeTimers();
      process.env.ESCROW_RECONCILIATION_SWEEP_INTERVAL_MS = '0';

      worker.onModuleInit();
      jest.advanceTimersByTime(60 * 60 * 1000);

      expect(reconciliationService.reconcile).not.toHaveBeenCalled();
    });

    it('stops sweeping once destroyed', () => {
      jest.useFakeTimers();
      process.env.ESCROW_RECONCILIATION_SWEEP_INTERVAL_MS = '1000';

      worker.onModuleInit();
      worker.onModuleDestroy();
      jest.advanceTimersByTime(10000);

      expect(reconciliationService.reconcile).not.toHaveBeenCalled();
    });
  });

  describe('sweep failures', () => {
    it('logs and swallows an error instead of crashing the interval', () => {
      jest.useFakeTimers();
      process.env.ESCROW_RECONCILIATION_SWEEP_INTERVAL_MS = '1000';
      reconciliationService.reconcile.mockRejectedValue(new Error('boom'));

      worker.onModuleInit();
      expect(() => jest.advanceTimersByTime(1000)).not.toThrow();
    });
  });
});
