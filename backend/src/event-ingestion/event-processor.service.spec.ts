import { Test, TestingModule } from '@nestjs/testing';
import { EventProcessorService, SorobanEvent } from './event-processor.service';
import { EscrowService } from '../escrow/escrow.service';

describe('EventProcessorService', () => {
  let service: EventProcessorService;

  const mockEscrowService = {
    create: jest.fn().mockResolvedValue({ id: 'esc-123', status: 'pending' }),
    findById: jest.fn().mockResolvedValue({ id: 'esc-123', status: 'pending' }),
    release: jest.fn().mockResolvedValue({ id: 'esc-123', status: 'released' }),
    raiseDispute: jest.fn().mockResolvedValue({ id: 'esc-123', status: 'disputed' }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [EventProcessorService, { provide: EscrowService, useValue: mockEscrowService }],
    }).compile();

    service = module.get<EventProcessorService>(EventProcessorService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('processEvent', () => {
    it('should process escrow_created event', async () => {
      const event: SorobanEvent = {
        id: 'event-1',
        ledger: 100,
        contractId: 'test-contract',
        eventType: 'escrow_created',
        topic: ['escrow_created'],
        value: {
          depositor: 'GABC...',
          beneficiary: 'GDEF...',
          amount: '100',
        },
        xdr: 'test-xdr',
        createdAt: new Date(),
      };

      const result = await service.processEvent(event);

      expect(result.success).toBe(true);
      expect(result.eventId).toBe('100-event-1');
      expect(mockEscrowService.create).toHaveBeenCalledWith('GABC...', 'GDEF...', '100');
    });

    it('should process escrow_released event', async () => {
      const event: SorobanEvent = {
        id: 'event-2',
        ledger: 101,
        contractId: 'test-contract',
        eventType: 'escrow_released',
        topic: ['escrow_released', 'esc-123'],
        value: {},
        xdr: 'test-xdr',
        createdAt: new Date(),
      };

      const result = await service.processEvent(event);

      expect(result.success).toBe(true);
      expect(mockEscrowService.release).toHaveBeenCalledWith('esc-123');
    });

    it('should process escrow_disputed event', async () => {
      const event: SorobanEvent = {
        id: 'event-3',
        ledger: 102,
        contractId: 'test-contract',
        eventType: 'escrow_disputed',
        topic: ['escrow_disputed', 'esc-123'],
        value: { reason: 'Service not delivered' },
        xdr: 'test-xdr',
        createdAt: new Date(),
      };

      const result = await service.processEvent(event);

      expect(result.success).toBe(true);
      expect(mockEscrowService.raiseDispute).toHaveBeenCalledWith(
        'esc-123',
        'Service not delivered',
      );
    });

    it('should skip already processed events', async () => {
      const event: SorobanEvent = {
        id: 'event-1',
        ledger: 100,
        contractId: 'test-contract',
        eventType: 'escrow_created',
        topic: ['escrow_created'],
        value: {},
        xdr: 'test-xdr',
        createdAt: new Date(),
      };

      await service.processEvent(event);
      const result = await service.processEvent(event);

      expect(result.success).toBe(true);
      expect(mockEscrowService.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('isEventProcessed', () => {
    it('should return false for unprocessed event', async () => {
      const isProcessed = await service.isEventProcessed('100-event-1');
      expect(isProcessed).toBe(false);
    });

    it('should return true for processed event', async () => {
      const event: SorobanEvent = {
        id: 'event-1',
        ledger: 100,
        contractId: 'test-contract',
        eventType: 'escrow_created',
        topic: ['escrow_created'],
        value: {},
        xdr: 'test-xdr',
        createdAt: new Date(),
      };

      await service.processEvent(event);
      const isProcessed = await service.isEventProcessed('100-event-1');
      expect(isProcessed).toBe(true);
    });
  });

  describe('clearEventsBeforeLedger', () => {
    it('should clear events before specified ledger', async () => {
      const event1: SorobanEvent = {
        id: 'event-1',
        ledger: 100,
        contractId: 'test-contract',
        eventType: 'escrow_created',
        topic: ['escrow_created'],
        value: {},
        xdr: 'test-xdr',
        createdAt: new Date(),
      };

      const event2: SorobanEvent = {
        id: 'event-2',
        ledger: 105,
        contractId: 'test-contract',
        eventType: 'escrow_created',
        topic: ['escrow_created'],
        value: {},
        xdr: 'test-xdr',
        createdAt: new Date(),
      };

      await service.processEvent(event1);
      await service.processEvent(event2);

      const cleared = await service.clearEventsBeforeLedger(103);
      expect(cleared).toBe(1);
    });
  });
});
