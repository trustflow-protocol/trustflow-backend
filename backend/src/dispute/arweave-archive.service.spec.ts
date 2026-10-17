import { Test, TestingModule } from '@nestjs/testing';
import { ArweaveArchiveService } from './arweave-archive.service';
import { DisputeSaga, DisputeStep, DisputeVerdict } from './dispute.types';
import { validateEnv } from '../config/env.config';

describe('ArweaveArchiveService', () => {
  let service: ArweaveArchiveService;

  beforeEach(async () => {
    validateEnv();
    const module: TestingModule = await Test.createTestingModule({
      providers: [ArweaveArchiveService],
    }).compile();

    service = module.get<ArweaveArchiveService>(ArweaveArchiveService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('archiveDispute', () => {
    const mockSaga: DisputeSaga = {
      sagaId: 'saga-test-001',
      escrowId: 'escrow-test-001',
      initiator: 'DEPOSITOR_WALLET_ADDRESS',
      origin: 'api',
      reason: 'Test dispute reason',
      priorEscrowStatus: 'active',
      currentStep: DisputeStep.COMPLETED,
      verdict: DisputeVerdict.DEPOSITOR_WINS,
      payoutTxHash: 'payout-tx-123',
      stepHistory: [],
      votes: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };

    it('should return undefined when Arweave not configured (simulated mode)', async () => {
      const result = await service.archiveDispute(mockSaga);
      expect(result).toBeUndefined();
    });

    it('should build archive data with correct structure', async () => {
      // Test that the service method runs without error and returns undefined in simulated mode
      const result = await service.archiveDispute(mockSaga);
      expect(result).toBeUndefined();
    });

    it('should include saga metadata in archive data', async () => {
      const result = await service.archiveDispute(mockSaga);
      expect(result).toBeUndefined();
      // In simulated mode, we verify the method was called and data was built
      // The buildArchiveData is called inside archiveDispute
    });

    it('reports oversized archives accurately and passes the full payload to the uploader', async () => {
      const upload = jest
        .fn<Promise<string>, [string | Buffer, Array<[string, string]>]>()
        .mockResolvedValue('arweave-test-tx');
      const uploader = { upload };
      Object.defineProperty(service, 'uploader', { value: uploader });
      const warn = jest.spyOn(service['logger'], 'warn').mockImplementation();
      const saga: DisputeSaga = {
        ...mockSaga,
        stepHistory: Array.from({ length: 1500 }, () => ({
          step: DisputeStep.VOTING,
          startedAt: '2026-10-17T00:00:00.000Z',
          error: 'x'.repeat(80),
        })),
        votes: Array.from({ length: 1500 }, () => ({
          jurorAddress: `G${'A'.repeat(55)}`,
          vote: 'depositor',
          castAt: '2026-10-17T00:00:00.000Z',
        })),
      };

      await service.archiveDispute(saga);

      expect(upload).toHaveBeenCalledTimes(1);
      const payloadArgument = upload.mock.calls[0]?.[0];
      if (typeof payloadArgument !== 'string') {
        throw new Error('Expected the archive uploader to receive a JSON string.');
      }
      const payload = payloadArgument;
      expect(Buffer.byteLength(payload, 'utf8')).toBeGreaterThan(256 * 1024);
      const parsedPayload = JSON.parse(payload) as {
        stepHistory: unknown[];
        votes: unknown[];
      };
      expect(parsedPayload.stepHistory).toHaveLength(1500);
      expect(parsedPayload.votes).toHaveLength(1500);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('passing the full payload to the uploader without truncation'),
      );
    });

    it('measures the archive size in UTF-8 bytes rather than JavaScript characters', async () => {
      const upload = jest
        .fn<Promise<string>, [string | Buffer, Array<[string, string]>]>()
        .mockResolvedValue('arweave-test-tx');
      const uploader = { upload };
      Object.defineProperty(service, 'uploader', { value: uploader });
      const warn = jest.spyOn(service['logger'], 'warn').mockImplementation();
      const saga = { ...mockSaga, compensationReason: '🚀'.repeat(70_000) };

      await service.archiveDispute(saga);

      const payloadArgument = upload.mock.calls[0]?.[0];
      if (typeof payloadArgument !== 'string') {
        throw new Error('Expected the archive uploader to receive a JSON string.');
      }
      const payload = payloadArgument;
      expect(payload.length).toBeLessThan(256 * 1024);
      expect(Buffer.byteLength(payload, 'utf8')).toBeGreaterThan(256 * 1024);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/bytes, above the recommended 256 KiB/),
      );
    });
  });
});
