import { MetricsService } from '../monitoring/metrics.service';
import { WebhookService } from '../webhook/webhook.service';
import { OutboxPublisherService } from './outbox-publisher.service';
import { OutboxRelayService } from './outbox-relay.service';
import { OutboxService } from './outbox.service';

describe('OutboxService and OutboxRelayService', () => {
  let metrics: jest.Mocked<Pick<MetricsService, 'increment'>>;
  let outbox: OutboxService;

  beforeEach(() => {
    metrics = { increment: jest.fn() };
    outbox = new OutboxService(null, metrics as unknown as MetricsService);
  });

  it('persists a pending event with a stable consumer deduplication key', async () => {
    const event = outbox.create('gig.created', 'gig', 'gig-1', { id: 'gig-1' });
    await outbox.append(event);

    expect(event.dedupKey).toBe('gig:gig-1:gig.created');
    expect(await outbox.findById(event.id)).toEqual(event);
  });

  it('claims a due event once, assigns a lease, and reclaims it after a worker crash', async () => {
    const event = outbox.create('gig.created', 'gig', 'gig-1', { id: 'gig-1' });
    await outbox.append(event);

    const now = Date.now();
    expect(await outbox.claimDue(now, 1000, 10)).toEqual([
      expect.objectContaining({ id: event.id }),
    ]);
    expect(await outbox.claimDue(now, 1000, 10)).toEqual([]);

    await outbox.reclaimExpired(now + 1001, 10);
    expect(await outbox.claimDue(now + 1001, 1000, 10)).toEqual([
      expect.objectContaining({ id: event.id }),
    ]);
  });

  it('reschedules failed delivery with an incremented attempt count', async () => {
    const event = outbox.create('gig.accepted', 'gig', 'gig-1', { id: 'gig-1' });
    await outbox.append(event);
    const [claimed] = await outbox.claimDue(Date.now(), 1000, 1);

    await outbox.retry(claimed, new Error('gateway offline'));
    const stored = await outbox.findById(event.id);

    expect(stored).toEqual(
      expect.objectContaining({
        status: 'pending',
        attempts: 1,
        lastError: 'gateway offline',
      }),
    );
    expect(stored!.nextAttemptAt).toBeGreaterThan(Date.now());
  });

  it('marks the event delivered only after every relay target succeeds', async () => {
    const event = outbox.create('gig.cancelled', 'gig', 'gig-1', { id: 'gig-1' });
    await outbox.append(event);
    const publisher = new OutboxPublisherService(null);
    const webhooks = {
      dispatch: jest.fn().mockResolvedValue(undefined),
    } as unknown as WebhookService;
    const relay = new OutboxRelayService(
      outbox,
      publisher,
      webhooks,
      metrics as unknown as MetricsService,
    );

    expect(await relay.runOnce()).toBe(1);
    expect(await outbox.findById(event.id)).toEqual(
      expect.objectContaining({ status: 'delivered', deliveredAt: expect.any(String) }),
    );
  });

  it('keeps a failed webhook delivery pending for at-least-once retry', async () => {
    const event = outbox.create('gig.expired', 'gig', 'gig-1', { id: 'gig-1' });
    await outbox.append(event);
    const publisher = new OutboxPublisherService(null);
    const webhooks = {
      dispatch: jest.fn().mockRejectedValue(new Error('receiver unavailable')),
    } as unknown as WebhookService;
    const relay = new OutboxRelayService(
      outbox,
      publisher,
      webhooks,
      metrics as unknown as MetricsService,
    );

    await relay.runOnce();

    expect(await outbox.findById(event.id)).toEqual(
      expect.objectContaining({
        status: 'pending',
        attempts: 1,
        lastError: 'receiver unavailable',
      }),
    );
  });
});
