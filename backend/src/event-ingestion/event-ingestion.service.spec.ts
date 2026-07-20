import { Test, TestingModule } from '@nestjs/testing';
import { EventIngestionService } from './event-ingestion.service';
import { LedgerCursorService } from './ledger-cursor.service';
import { EventProcessorService } from './event-processor.service';
import { EscrowService } from '../escrow/escrow.service';

describe('EventIngestionService', () => {
  let service: EventIngestionService;
  let ledgerCursorService: LedgerCursorService;
  let eventProcessorService: EventProcessorService;

  const mockEscrowService = {
    create: jest.fn(),
    findById: jest.fn(),
    release: jest.fn(),
    raiseDispute: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventIngestionService,
        LedgerCursorService,
        EventProcessorService,
        { provide: EscrowService, useValue: mockEscrowService },
      ],
    }).compile();

    service = module.get<EventIngestionService>(EventIngestionService);
    ledgerCursorService = module.get<LedgerCursorService>(LedgerCursorService);
    eventProcessorService = module.get<EventProcessorService>(EventProcessorService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getStatus', () => {
    it('should return current status', async () => {
      const status = await service.getStatus();
      expect(status).toHaveProperty('isRunning');
      expect(status).toHaveProperty('failedEvents');
    });
  });

  describe('startPolling and stopPolling', () => {
    it('should start and stop polling', async () => {
      await service.startPolling('test-contract');
      expect(service['isRunning']).toBe(true);

      service.stopPolling();
      expect(service['isRunning']).toBe(false);
    });
  });

  describe('handleReorg', () => {
    it('should handle reorg by clearing events and resetting cursor', async () => {
      const clearSpy = jest.spyOn(eventProcessorService, 'clearEventsBeforeLedger');
      const updateSpy = jest.spyOn(ledgerCursorService, 'updateCursor');

      await service.handleReorg('test-contract', 100);

      expect(clearSpy).toHaveBeenCalledWith(100);
      expect(updateSpy).toHaveBeenCalledWith('test-contract', 99, 'reorg-100', '');
    });
  });
});
