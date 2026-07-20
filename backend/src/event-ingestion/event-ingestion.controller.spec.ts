import { Test, TestingModule } from '@nestjs/testing';
import { EventIngestionController } from './event-ingestion.controller';
import { EventIngestionService } from './event-ingestion.service';
import { LedgerCursorService } from './ledger-cursor.service';
import { EventProcessorService } from './event-processor.service';
import { EscrowService } from '../escrow/escrow.service';

describe('EventIngestionController', () => {
  let controller: EventIngestionController;
  let service: EventIngestionService;

  const mockEscrowService = {
    create: jest.fn(),
    findById: jest.fn(),
    release: jest.fn(),
    raiseDispute: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EventIngestionController],
      providers: [
        EventIngestionService,
        LedgerCursorService,
        EventProcessorService,
        { provide: EscrowService, useValue: mockEscrowService },
      ],
    }).compile();

    controller = module.get<EventIngestionController>(EventIngestionController);
    service = module.get<EventIngestionService>(EventIngestionService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('startPolling', () => {
    it('should start polling', async () => {
      const startSpy = jest.spyOn(service, 'startPolling').mockResolvedValue();
      await controller.startPolling({ contractId: 'test-contract' });
      expect(startSpy).toHaveBeenCalledWith('test-contract');
    });
  });

  describe('stopPolling', () => {
    it('should stop polling', async () => {
      const stopSpy = jest.spyOn(service, 'stopPolling');
      await controller.stopPolling();
      expect(stopSpy).toHaveBeenCalled();
    });
  });

  describe('getStatus', () => {
    it('should return status', async () => {
      const statusSpy = jest.spyOn(service, 'getStatus').mockResolvedValue({
        isRunning: false,
        failedEvents: 0,
      });
      const result = await controller.getStatus();
      expect(result).toHaveProperty('isRunning');
      expect(statusSpy).toHaveBeenCalled();
    });
  });
});
