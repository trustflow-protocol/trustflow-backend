import { GigExpiryWorkerService } from './gig-expiry-worker.service';
import { GigService } from './gig.service';
import { Gig, GigStatus } from './gig.entity';
import { DistributedLockService } from '../common/redis/distributed-lock.service';

/** Flushes the microtask queue so chained awaits inside a fake-timer tick settle. */
async function flushPromises(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

/** Always grants the lock — the distributed-lock mechanics themselves are covered by distributed-lock.service.spec.ts. */
function fakeLock(): jest.Mocked<Pick<DistributedLockService, 'tryAcquire' | 'release'>> {
  return {
    tryAcquire: jest.fn().mockResolvedValue('fake-token'),
    release: jest.fn().mockResolvedValue(undefined),
  };
}

function makeGig(id: string, status: GigStatus): Gig {
  return {
    id,
    creator: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    title: 'Test gig',
    budgetXLM: '100',
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
    respondBy: '2026-01-01T01:00:00.000Z',
  };
}

describe('GigExpiryWorkerService', () => {
  const originalInterval = process.env.GIG_EXPIRY_SWEEP_INTERVAL_MS;
  let gigService: jest.Mocked<Pick<GigService, 'findExpirable' | 'expire'>>;
  let worker: GigExpiryWorkerService;

  beforeEach(() => {
    gigService = {
      findExpirable: jest.fn().mockResolvedValue([]),
      expire: jest.fn(),
    };
    worker = new GigExpiryWorkerService(
      gigService as unknown as GigService,
      fakeLock() as unknown as DistributedLockService,
    );
  });

  afterEach(() => {
    worker.onModuleDestroy();
    jest.useRealTimers();
    if (originalInterval === undefined) delete process.env.GIG_EXPIRY_SWEEP_INTERVAL_MS;
    else process.env.GIG_EXPIRY_SWEEP_INTERVAL_MS = originalInterval;
  });

  describe('runOnce', () => {
    it('expires every gig returned by findExpirable; GigService persists the outbox event', async () => {
      const expiredGig = {
        ...makeGig('gig-a', GigStatus.EXPIRED),
        expiredAt: '2026-01-01T02:00:00.000Z',
      };
      gigService.findExpirable.mockResolvedValue([makeGig('gig-a', GigStatus.OPEN)]);
      gigService.expire.mockResolvedValue(expiredGig);

      await worker.runOnce();

      expect(gigService.expire).toHaveBeenCalledWith('gig-a');
    });

    it('skips already-resolved gigs', async () => {
      gigService.findExpirable.mockResolvedValue([makeGig('gig-a', GigStatus.OPEN)]);
      gigService.expire.mockResolvedValue(undefined);

      await worker.runOnce();

      expect(gigService.expire).toHaveBeenCalledWith('gig-a');
    });

    it('processes every expirable gig even when the list has multiple entries', async () => {
      gigService.findExpirable.mockResolvedValue([
        makeGig('gig-a', GigStatus.OPEN),
        makeGig('gig-b', GigStatus.OPEN),
      ]);
      gigService.expire.mockImplementation(async id => makeGig(id, GigStatus.EXPIRED));

      await worker.runOnce();

      expect(gigService.expire).toHaveBeenCalledTimes(2);
    });
  });

  describe('onModuleInit / onModuleDestroy', () => {
    it('schedules periodic sweeps at the default interval', () => {
      jest.useFakeTimers();
      delete process.env.GIG_EXPIRY_SWEEP_INTERVAL_MS;
      gigService.findExpirable.mockResolvedValue([makeGig('gig-a', GigStatus.OPEN)]);
      gigService.expire.mockResolvedValue(makeGig('gig-a', GigStatus.EXPIRED));

      worker.onModuleInit();
      expect(gigService.expire).not.toHaveBeenCalled();

      jest.advanceTimersByTime(5 * 60 * 1000);
      return flushPromises().then(() => {
        expect(gigService.expire).toHaveBeenCalledWith('gig-a');
      });
    });

    it('honors a custom GIG_EXPIRY_SWEEP_INTERVAL_MS', () => {
      jest.useFakeTimers();
      process.env.GIG_EXPIRY_SWEEP_INTERVAL_MS = '1000';
      gigService.findExpirable.mockResolvedValue([makeGig('gig-a', GigStatus.OPEN)]);
      gigService.expire.mockResolvedValue(makeGig('gig-a', GigStatus.EXPIRED));

      worker.onModuleInit();
      jest.advanceTimersByTime(999);
      expect(gigService.expire).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      return flushPromises().then(() => {
        expect(gigService.expire).toHaveBeenCalledWith('gig-a');
      });
    });

    it('does not schedule a sweep when the interval is disabled', () => {
      jest.useFakeTimers();
      process.env.GIG_EXPIRY_SWEEP_INTERVAL_MS = '0';

      worker.onModuleInit();
      jest.advanceTimersByTime(60 * 60 * 1000);

      expect(gigService.findExpirable).not.toHaveBeenCalled();
    });

    it('stops sweeping once destroyed', () => {
      jest.useFakeTimers();
      process.env.GIG_EXPIRY_SWEEP_INTERVAL_MS = '1000';
      gigService.findExpirable.mockResolvedValue([makeGig('gig-a', GigStatus.OPEN)]);

      worker.onModuleInit();
      worker.onModuleDestroy();
      jest.advanceTimersByTime(10000);

      expect(gigService.findExpirable).not.toHaveBeenCalled();
    });
  });
});

describe('GigExpiryWorkerService — concurrency & non-overlap (#236)', () => {
  const originalInterval = process.env.GIG_EXPIRY_SWEEP_INTERVAL_MS;

  afterEach(() => {
    if (originalInterval === undefined) delete process.env.GIG_EXPIRY_SWEEP_INTERVAL_MS;
    else process.env.GIG_EXPIRY_SWEEP_INTERVAL_MS = originalInterval;
    jest.useRealTimers();
  });

  function slowGigService(
    perGigMs: number,
  ): jest.Mocked<Pick<GigService, 'findExpirable' | 'expire'>> {
    const gigs = Array.from({ length: 10 }, (_, i) => makeGig(`g${i}`, GigStatus.OPEN));
    return {
      findExpirable: jest.fn().mockResolvedValue(gigs),
      expire: jest.fn().mockImplementation(
        () => new Promise(r => setTimeout(() => r(true), perGigMs)),
      ),
    };
  }

  it('expires gigs concurrently — a 10-gig sweep is far faster than 10x one gig', async () => {
    const gigService = slowGigService(20);
    const worker = new GigExpiryWorkerService(
      gigService as unknown as GigService,
      fakeLock() as unknown as DistributedLockService,
    );

    const start = Date.now();
    await worker.runOnce();
    const elapsed = Date.now() - start;

    expect(gigService.expire).toHaveBeenCalledTimes(10);
    // Sequential would be ~200ms; bounded-concurrency finishes well under half.
    expect(elapsed).toBeLessThan(120);
  });

  it('skips a tick while a previous sweep is still running', async () => {
    jest.useFakeTimers();
    process.env.GIG_EXPIRY_SWEEP_INTERVAL_MS = '10';

    let resolveSweep!: () => void;
    const gigService: jest.Mocked<Pick<GigService, 'findExpirable' | 'expire'>> = {
      findExpirable: jest.fn().mockReturnValue(new Promise<never>(() => {})),
      expire: jest.fn(),
    };
    // First sweep hangs until we release it.
    gigService.findExpirable.mockImplementationOnce(
      () => new Promise(res => { resolveSweep = () => res([]); }),
    );

    const lock = fakeLock();
    const worker = new GigExpiryWorkerService(
      gigService as unknown as GigService,
      lock as unknown as DistributedLockService,
    );
    worker.onModuleInit();

    jest.advanceTimersByTime(35); // several ticks while the first sweep is stuck
    await flushPromises();

    // Only the first tick got past the in-flight guard.
    expect(gigService.findExpirable).toHaveBeenCalledTimes(1);

    resolveSweep();
    await flushPromises();
    worker.onModuleDestroy();
  });
});
