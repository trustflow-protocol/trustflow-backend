import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { MilestoneNotificationsGateway } from './milestone-notifications.gateway';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { OUTBOX_GATEWAY_CHANNEL } from '../outbox/outbox-publisher.service';
import { OutboxEvent } from '../outbox/outbox.types';
import { Server } from 'http';
import { Socket, io } from 'socket.io-client';

describe('MilestoneNotificationsGateway', () => {
  let app: INestApplication;
  let gateway: MilestoneNotificationsGateway;
  let clientSocket: Socket;
  
  // Fake Redis Subscriber
  let fakeRedis: any;
  let subscriberCallback: ((channel: string, message: string) => void) | null = null;

  beforeAll(async () => {
    fakeRedis = {
      duplicate: jest.fn().mockReturnThis(),
      on: jest.fn((event, cb) => {
        if (event === 'message') {
          subscriberCallback = cb;
        }
      }),
      subscribe: jest.fn((channel, cb) => cb(null)),
      unsubscribe: jest.fn().mockResolvedValue(true),
      disconnect: jest.fn(),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      providers: [
        MilestoneNotificationsGateway,
        {
          provide: REDIS_CLIENT,
          useValue: fakeRedis,
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useWebSocketAdapter(new IoAdapter(app));
    await app.init();
    gateway = moduleFixture.get<MilestoneNotificationsGateway>(MilestoneNotificationsGateway);
    
    // We need to listen on a random port to test with socket.io-client
    const server = app.getHttpServer() as Server;
    await new Promise<void>((resolve) => server.listen(0, resolve));
    
    const address = server.address();
    const port = typeof address === 'string' ? 0 : address?.port;
    
    clientSocket = io(`http://localhost:${port}`);
    
    await new Promise<void>((resolve) => {
      clientSocket.on('connect', resolve);
    });
  });

  afterAll(async () => {
    clientSocket.disconnect();
    await app.close();
  });

  it('should deliver events to clients in the right room', (done) => {
    const gigId = 'gig-123';
    
    clientSocket.emit('subscribe:gig', { gigId }, (response: any) => {
      expect(response.event).toBe('subscribed');
      
      clientSocket.once('milestone:update', (payload) => {
        expect(payload).toEqual({
          v: 1,
          type: 'gig.accepted',
          data: { success: true },
        });
        done();
      });

      const event: OutboxEvent = {
        id: '1',
        dedupKey: 'dedup-1',
        type: 'gig.accepted',
        aggregateType: 'gig',
        aggregateId: gigId,
        payload: { success: true },
        status: 'pending',
        attempts: 0,
        nextAttemptAt: 0,
        createdAt: '',
      };
      
      // Simulate redis message
      if (subscriberCallback) {
        subscriberCallback(OUTBOX_GATEWAY_CHANNEL, JSON.stringify(event));
      }
    });
  });

  it('should drop duplicate messages by dedupKey', (done) => {
    const gigId = 'gig-456';
    let count = 0;
    
    clientSocket.emit('subscribe:gig', { gigId }, () => {
      clientSocket.on('deliverable:uploaded', (payload) => {
        count++;
        // If it was called twice, count would be 2, which would fail the test
      });

      const event: OutboxEvent = {
        id: '2',
        dedupKey: 'dedup-2',
        type: 'deliverable.uploaded',
        aggregateType: 'gig',
        aggregateId: gigId,
        payload: { file: 'a.pdf' },
        status: 'pending',
        attempts: 0,
        nextAttemptAt: 0,
        createdAt: '',
      };
      
      if (subscriberCallback) {
        subscriberCallback(OUTBOX_GATEWAY_CHANNEL, JSON.stringify(event));
        subscriberCallback(OUTBOX_GATEWAY_CHANNEL, JSON.stringify(event)); // Duplicate
      }
      
      setTimeout(() => {
        expect(count).toBe(1);
        clientSocket.off('deliverable:uploaded');
        done();
      }, 200);
    });
  });
  
  it('should unsubscribe and disconnect on destroy', () => {
    gateway.onModuleDestroy();
    expect(fakeRedis.unsubscribe).toHaveBeenCalledWith(OUTBOX_GATEWAY_CHANNEL);
    expect(fakeRedis.disconnect).toHaveBeenCalled();
  });
});
