import { GigExpiryWorkerService } from './gig-expiry-worker.service';
import { GigService } from './gig.service';
import { WebhookService } from '../webhook/webhook.service';
import { GIG_EVENTS, Gig, GigStatus } from './gig.entity';

/** Flushes the microtask queue so chained awaits inside a fake-timer tick settle. */
async function flushPromises(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
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
  let webhookService: jest.Mocked<Pick<WebhookService, 'dispatch'>>;
  let worker: GigExpiryWorkerService;

  beforeEach(() => {
    gigService = {
      findExpirable: jest.fn().mockResolvedValue([]),
      expire: jest.fn(),
    };
    webhookService = {
      dispatch: jest.fn().mockResolvedValue(undefined),
    };
    worker = new GigExpiryWorkerService(
      gigService as unknown as GigService,
      webhookService as unknown as WebhookService,
    );
  });

  afterEach(() => {
    worker.onModuleDestroy();
    jest.useRealTimers();
    if (originalInterval === undefined) delete process.env.GIG_EXPIRY_SWEEP_INTERVAL_MS;
    else process.env.GIG_EXPIRY_SWEEP_INTERVAL_MS = originalInterval;
  });

  describe('runOnce', () => {
    it('expires every gig returned by findExpirable and dispatches a webhook for each', async () => {
      const expiredGig = {
        ...makeGig('gig-a', GigStatus.EXPIRED),
        expiredAt: '2026-01-01T02:00:00.000Z',
      };
      gigService.findExpirable.mockResolvedValue([makeGig('gig-a', GigStatus.OPEN)]);
      gigService.expire.mockResolvedValue(expiredGig);

      await worker.runOnce();

      expect(gigService.expire).toHaveBeenCalledWith('gig-a');
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        GIG_EVENTS.GIG_EXPIRED,
        expect.objectContaining({ gigId: 'gig-a', expiredAt: expiredGig.expiredAt }),
      );
    });

    it('skips dispatching when expire() returns undefined (already resolved)', async () => {
      gigService.findExpirable.mockResolvedValue([makeGig('gig-a', GigStatus.OPEN)]);
      gigService.expire.mockResolvedValue(undefined);

      await worker.runOnce();

      expect(webhookService.dispatch).not.toHaveBeenCalled();
    });

    it('processes every expirable gig even when the list has multiple entries', async () => {
      gigService.findExpirable.mockResolvedValue([
        makeGig('gig-a', GigStatus.OPEN),
        makeGig('gig-b', GigStatus.OPEN),
      ]);
      gigService.expire.mockImplementation(async id => makeGig(id, GigStatus.EXPIRED));

      await worker.runOnce();

      expect(gigService.expire).toHaveBeenCalledTimes(2);
      expect(webhookService.dispatch).toHaveBeenCalledTimes(2);
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
