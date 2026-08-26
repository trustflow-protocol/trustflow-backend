import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { JwtAuthGuard } from '../auth/auth.guard';
import { OutboxController } from './outbox.controller';
import { OutboxRelayService } from './outbox-relay.service';
import { OutboxService } from './outbox.service';

describe('OutboxController', () => {
  let app: INestApplication;
  const event = {
    id: 'event-1',
    dedupKey: 'gig:gig-1:gig.created',
    type: 'gig.created',
    aggregateType: 'gig',
    aggregateId: 'gig-1',
    payload: { id: 'gig-1' },
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const outbox = { findById: jest.fn() };
  const relay = { runOnce: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      controllers: [OutboxController],
      providers: [
        { provide: OutboxService, useValue: outbox },
        { provide: OutboxRelayService, useValue: relay },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns an event and its consumer deduplication key', async () => {
    outbox.findById.mockResolvedValue(event);

    const response = await request(app.getHttpServer()).get('/outbox/event-1').expect(200);

    expect(response.body).toEqual(event);
    expect(outbox.findById).toHaveBeenCalledWith('event-1');
  });

  it('returns 404 for an unknown event', async () => {
    outbox.findById.mockResolvedValue(undefined);
    await request(app.getHttpServer()).get('/outbox/missing').expect(404);
  });

  it('runs a relay batch through the operational endpoint', async () => {
    relay.runOnce.mockResolvedValue(3);

    await request(app.getHttpServer()).post('/outbox/relay').expect(202).expect({ processed: 3 });
  });
});
