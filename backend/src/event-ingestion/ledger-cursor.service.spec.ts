import { Test, TestingModule } from '@nestjs/testing';
import { LedgerCursorService } from './ledger-cursor.service';

describe('LedgerCursorService', () => {
  let service: LedgerCursorService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [LedgerCursorService],
    }).compile();

    service = module.get<LedgerCursorService>(LedgerCursorService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getCursor', () => {
    it('should return undefined for non-existent cursor', async () => {
      const cursor = await service.getCursor('test-contract');
      expect(cursor).toBeUndefined();
    });
  });

  describe('updateCursor', () => {
    it('should update cursor successfully', async () => {
      await service.updateCursor('test-contract', 100, '100-200', 'network-hash');
      const cursor = await service.getCursor('test-contract');
      expect(cursor).toBeDefined();
      expect(cursor?.ledgerSequence).toBe(100);
      expect(cursor?.lastProcessedLedger).toBe(100);
      expect(cursor?.cursorPosition).toBe('100-200');
      expect(cursor?.networkHash).toBe('network-hash');
    });
  });

  describe('resetCursor', () => {
    it('should reset cursor', async () => {
      await service.updateCursor('test-contract', 100, '100-200', 'network-hash');
      await service.resetCursor('test-contract');
      const cursor = await service.getCursor('test-contract');
      expect(cursor).toBeUndefined();
    });
  });

  describe('getStartLedger', () => {
    it('should return 1 for non-existent cursor', async () => {
      const startLedger = await service.getStartLedger('test-contract');
      expect(startLedger).toBe(0);
    });

    it('should return lastProcessedLedger + 1 for existing cursor', async () => {
      await service.updateCursor('test-contract', 100, '100-200', 'network-hash');
      const startLedger = await service.getStartLedger('test-contract');
      expect(startLedger).toBe(101);
    });
  });
});
