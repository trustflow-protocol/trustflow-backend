import { Redis } from 'ioredis';
import {
  OutboxPublisherService,
  OUTBOX_GATEWAY_CHANNEL,
  OUTBOX_QUEUE_KEY,
} from './outbox-publisher.service';
import { OutboxEvent } from './outbox.types';
import { validateEnv } from '../config/env.config';

validateEnv();

const EVENT: OutboxEvent = {
  id: 'evt-1',
  dedupKey: 'gig:1:accepted',
  type: 'gig.accepted',
  aggregateType: 'gig',
  aggregateId: 'gig-1',
  payload: {},
  status: 'processing',
  attempts: 0,
  nextAttemptAt: 0,
  createdAt: new Date(0).toISOString(),
};

function fakeRedis(execResult: Array<[Error | null, unknown]> | null) {
  const multi = {
    publish: jest.fn().mockReturnThis(),
    lpush: jest.fn().mockReturnThis(),
    ltrim: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(execResult),
  };
  return { redis: { multi: jest.fn(() => multi) } as unknown as Redis, multi };
}

describe('OutboxPublisherService', () => {
  it('is a no-op without Redis', async () => {
    await expect(new OutboxPublisherService(null).publish(EVENT)).resolves.toBeUndefined();
  });

  it('publishes to the gateway channel and appends to the capped queue atomically', async () => {
    const { redis, multi } = fakeRedis([
      [null, 1],
      [null, 1],
      [null, 'OK'],
    ]);

    await new OutboxPublisherService(redis).publish(EVENT);

    const payload = JSON.stringify(EVENT);
    expect(multi.publish).toHaveBeenCalledWith(OUTBOX_GATEWAY_CHANNEL, payload);
    expect(multi.lpush).toHaveBeenCalledWith(OUTBOX_QUEUE_KEY, payload);
    expect(multi.ltrim).toHaveBeenCalledWith(OUTBOX_QUEUE_KEY, 0, 999);
    expect(multi.exec).toHaveBeenCalledTimes(1);
  });

  it('throws when the transaction is aborted', async () => {
    const { redis } = fakeRedis(null);
    await expect(new OutboxPublisherService(redis).publish(EVENT)).rejects.toThrow(
      'Redis outbox publish transaction aborted',
    );
  });

  it('surfaces the first failed command', async () => {
    const failure = new Error('OOM');
    const { redis } = fakeRedis([
      [null, 1],
      [failure, null],
      [null, 'OK'],
    ]);
    await expect(new OutboxPublisherService(redis).publish(EVENT)).rejects.toBe(failure);
  });
});
