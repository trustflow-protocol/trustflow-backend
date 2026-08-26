import { Test, TestingModule } from '@nestjs/testing';
import { SorobanEventIndexerService } from './soroban-event-indexer.service';
import { REDIS_CLIENT } from '../common/redis/redis.module';

describe('SorobanEventIndexerService', () => {
  let service: SorobanEventIndexerService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SorobanEventIndexerService,
        { provide: REDIS_CLIENT, useValue: null },
      ],
    }).compile();

    service = module.get<SorobanEventIndexerService>(SorobanEventIndexerService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('starts and stops without error', () => {
    service.start();
    service.stop();
  });

  it('getEvents returns empty array when no Redis', async () => {
    const events = await service.getEvents();
    expect(events).toEqual([]);
  });
});
