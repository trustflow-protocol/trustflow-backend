import { Test, TestingModule } from '@nestjs/testing';
import { SorobanEventIndexerService } from './soroban-event-indexer.service';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { rpc as SorobanRpc, nativeToScVal, scValToNative } from '@stellar/stellar-sdk';
import { Redis } from 'ioredis';
import * as stellarConfig from '../stellar/stellar.config';

jest.mock('@stellar/stellar-sdk', () => {
  const original = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...original,
    rpc: {
      ...original.rpc,
      Server: jest.fn().mockImplementation(() => ({
        getHealth: jest.fn(),
        getEvents: jest.fn(),
      })),
    }
  };
});

const describeIfRedis = process.env.REDIS_URL ? describe : describe.skip;

describe('SorobanEventIndexerService (Unit)', () => {
  let service: SorobanEventIndexerService;
  let rpcServerMock: any;

  beforeEach(async () => {
    jest.spyOn(stellarConfig, 'getStellarConfig').mockReturnValue({
      contractId: 'CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      sorobanRpcUrl: 'http://localhost:8000',
    } as any);

    const module: TestingModule = await Test.createTestingModule({
      providers: [SorobanEventIndexerService, { provide: REDIS_CLIENT, useValue: null }],
    }).compile();

    service = module.get<SorobanEventIndexerService>(SorobanEventIndexerService);
    service.onModuleInit();
    rpcServerMock = (service as any).rpcServer;
  });

  afterEach(() => {
    service.stop();
    jest.restoreAllMocks();
  });

  it('starts and stops cleanly, idempotently', () => {
    service.start();
    const interval = (service as any).pollingInterval;
    expect(interval).toBeTruthy();

    service.start(); // idempotent
    expect((service as any).pollingInterval).toBe(interval);

    service.stop();
    expect((service as any).pollingInterval).toBeNull();
    service.onModuleDestroy();
  });

  it('poll() skips if no contractId', async () => {
    jest.spyOn(stellarConfig, 'getStellarConfig').mockReturnValue({} as any);
    const events = await service.poll();
    expect(events).toEqual([]);
    expect(rpcServerMock.getHealth).not.toHaveBeenCalled();
  });

  it('poll() returns empty if nothing new (startLedger > endLedger)', async () => {
    rpcServerMock.getHealth.mockResolvedValue({ latestLedger: 0, oldestLedger: 0 });
    const events = await service.poll();
    expect(events).toEqual([]);
    expect(rpcServerMock.getEvents).not.toHaveBeenCalled();
  });

  it('poll() fetches and parses events without Redis (null client)', async () => {
    rpcServerMock.getHealth.mockResolvedValue({ latestLedger: 10, oldestLedger: 1 });
    const val = nativeToScVal('test_value', { type: 'symbol' });
    const rawEvent = {
      id: 'event-1',
      ledger: 5,
      contractId: 'C123',
      topic: [nativeToScVal('EVENT_TOPIC', { type: 'symbol' })],
      value: val,
    };
    rpcServerMock.getEvents.mockResolvedValue({ events: [rawEvent] });
    
    const events = await service.poll();
    expect(events).toHaveLength(1);
    expect(events[0].eventId).toBe('event-1');
    expect(events[0].eventType).toBe('EVENT_TOPIC');
  });
});

describeIfRedis('SorobanEventIndexerService (Redis integration)', () => {
  let redis: Redis;
  let service: SorobanEventIndexerService;
  let rpcServerMock: any;

  beforeAll(() => {
    redis = new Redis(process.env.REDIS_URL!);
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    const keys = await redis.keys('soroban:*');
    if (keys.length > 0) await redis.del(...keys);

    jest.spyOn(stellarConfig, 'getStellarConfig').mockReturnValue({
      contractId: 'CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      sorobanRpcUrl: 'http://localhost:8000',
    } as any);

    const module: TestingModule = await Test.createTestingModule({
      providers: [SorobanEventIndexerService, { provide: REDIS_CLIENT, useValue: redis }],
    }).compile();

    service = module.get<SorobanEventIndexerService>(SorobanEventIndexerService);
    service.onModuleInit();
    rpcServerMock = (service as any).rpcServer;
  });

  afterEach(() => {
    service.stop();
    jest.restoreAllMocks();
  });

  it('poll() normal window with persistence across polls', async () => {
    rpcServerMock.getHealth.mockResolvedValue({ latestLedger: 5, oldestLedger: 1 });
    const rawEvent = {
      id: 'event-1',
      ledger: 2,
      contractId: 'C123',
      topic: [nativeToScVal('TOPIC_1', { type: 'symbol' })],
      value: nativeToScVal(123),
    };
    rpcServerMock.getEvents.mockResolvedValueOnce({ events: [rawEvent] });
    
    await service.poll();
    expect(rpcServerMock.getEvents).toHaveBeenCalledWith(expect.objectContaining({ startLedger: 1 }));
    let cursor = await redis.get('soroban:event-indexer:cursor');
    expect(cursor).toBe('5');

    rpcServerMock.getHealth.mockResolvedValue({ latestLedger: 10, oldestLedger: 1 });
    rpcServerMock.getEvents.mockResolvedValueOnce({ events: [] });
    
    await service.poll();
    expect(rpcServerMock.getEvents).toHaveBeenCalledWith(expect.objectContaining({ startLedger: 6 }));
    cursor = await redis.get('soroban:event-indexer:cursor');
    expect(cursor).toBe('10');
  });

  it('storeEvent() failure semantics: swallows error and cursor advances', async () => {
    rpcServerMock.getHealth.mockResolvedValue({ latestLedger: 5, oldestLedger: 1 });
    const rawEvent = {
      id: 'event-2',
      ledger: 2,
      contractId: 'C123',
      topic: [nativeToScVal('TOPIC', { type: 'symbol' })],
      value: nativeToScVal(1),
    };
    rpcServerMock.getEvents.mockResolvedValueOnce({ events: [rawEvent] });

    jest.spyOn(redis, 'multi').mockImplementationOnce(() => {
      throw new Error('Redis multi failed');
    });

    await service.poll(); // should not throw
    const cursor = await redis.get('soroban:event-indexer:cursor');
    expect(cursor).toBe('5');
  });

  it('getEvents() ordering, limit handling, and missing keys', async () => {
    rpcServerMock.getHealth.mockResolvedValue({ latestLedger: 10, oldestLedger: 1 });
    const events = [
      { id: 'ev1', ledger: 2, contractId: 'C', topic: [nativeToScVal('A', { type: 'symbol' })], value: nativeToScVal(1) },
      { id: 'ev2', ledger: 4, contractId: 'C', topic: [nativeToScVal('B', { type: 'symbol' })], value: nativeToScVal(2) },
      { id: 'ev3', ledger: 6, contractId: 'C', topic: [nativeToScVal('C', { type: 'symbol' })], value: nativeToScVal(3) },
    ];
    rpcServerMock.getEvents.mockResolvedValueOnce({ events });
    
    await service.poll();

    const fetched2 = await service.getEvents(2);
    expect(fetched2).toHaveLength(2);
    expect(fetched2[0].eventId).toBe('ev3');
    expect(fetched2[1].eventId).toBe('ev2');

    await redis.del('soroban:event:ev3');
    
    const fetchedAfterDel = await service.getEvents(3);
    expect(fetchedAfterDel).toHaveLength(2);
    expect(fetchedAfterDel[0].eventId).toBe('ev2');
    expect(fetchedAfterDel[1].eventId).toBe('ev1');
  });
});
