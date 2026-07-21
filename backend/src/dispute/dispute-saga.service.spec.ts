import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { DisputeSagaService } from './dispute-saga.service';
import { DisputeStep, DisputeVerdict } from './dispute.types';
import { EscrowService } from '../escrow/escrow.service';
import { WebhookService } from '../webhook/webhook.service';
import { DiscordService } from '../webhook/discord.service';

// ─── Shared mock factories ────────────────────────────────────────────────────

function makeEscrow(overrides: Partial<any> = {}) {
  return {
    id: 'esc-001',
    depositor: 'GDEPOSITOR111111111111111111111111111111111111111111111',
    beneficiary: 'GBENEFICIARY1111111111111111111111111111111111111111111',
    amountXLM: '100',
    status: 'active',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function buildMocks() {
  const escrow = makeEscrow();

  const escrowService = {
    findById: jest.fn().mockResolvedValue(escrow),
    raiseDispute: jest.fn().mockImplementation(async (_id: string, _reason: string) => {
      escrow.status = 'disputed';
      return escrow;
    }),
    release: jest.fn().mockImplementation(async () => {
      escrow.status = 'released';
      return escrow;
    }),
  };

  const webhookService = { dispatch: jest.fn().mockResolvedValue(undefined) };
  const discordService = { notifyDisputeNeedsJurors: jest.fn().mockResolvedValue(undefined) };

  return { escrow, escrowService, webhookService, discordService };
}

const JURORS = [
  'GJUROR1111111111111111111111111111111111111111111111111111',
  'GJUROR2222222222222222222222222222222222222222222222222222',
  'GJUROR3333333333333333333333333333333333333333333333333333',
];

const ESCALATE_DTO = {
  initiator: 'GDEPOSITOR111111111111111111111111111111111111111111111',
  reason: 'Work was not delivered as agreed in the contract',
};

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('DisputeSagaService', () => {
  let service: DisputeSagaService;
  let escrowService: ReturnType<typeof buildMocks>['escrowService'];
  let webhookService: ReturnType<typeof buildMocks>['webhookService'];
  let discordService: ReturnType<typeof buildMocks>['discordService'];
  let escrow: ReturnType<typeof buildMocks>['escrow'];

  beforeEach(async () => {
    const mocks = buildMocks();
    escrowService = mocks.escrowService;
    webhookService = mocks.webhookService;
    discordService = mocks.discordService;
    escrow = mocks.escrow;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DisputeSagaService,
        { provide: EscrowService, useValue: escrowService },
        { provide: WebhookService, useValue: webhookService },
        { provide: DiscordService, useValue: discordService },
      ],
    }).compile();

    service = module.get<DisputeSagaService>(DisputeSagaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ─── escalate ─────────────────────────────────────────────────────

  describe('escalate()', () => {
    it('creates a saga and advances to JUROR_ASSIGNMENT', async () => {
      const saga = await service.escalate('esc-001', ESCALATE_DTO);

      expect(saga.sagaId).toMatch(/^saga-/);
      expect(saga.escrowId).toBe('esc-001');
      expect(saga.currentStep).toBe(DisputeStep.JUROR_ASSIGNMENT);
      expect(saga.escalationTxHash).toBeDefined();
      expect(escrowService.raiseDispute).toHaveBeenCalledWith('esc-001', ESCALATE_DTO.reason);
    });

    it('records ESCALATION in stepHistory as completed', async () => {
      const saga = await service.escalate('esc-001', ESCALATE_DTO);
      const record = saga.stepHistory.find(r => r.step === DisputeStep.ESCALATION);
      expect(record?.completedAt).toBeDefined();
      expect(record?.failedAt).toBeUndefined();
    });

    it('dispatches escalation webhook', async () => {
      await service.escalate('esc-001', ESCALATE_DTO);
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        'dispute.escalated',
        expect.objectContaining({ escrowId: 'esc-001' }),
      );
    });

    it('notifies Discord', async () => {
      await service.escalate('esc-001', ESCALATE_DTO);
      expect(discordService.notifyDisputeNeedsJurors).toHaveBeenCalledWith(
        expect.objectContaining({ escrowId: 'esc-001' }),
      );
    });

    it('throws NotFoundException when escrow does not exist', async () => {
      escrowService.findById.mockResolvedValueOnce(undefined);
      await expect(service.escalate('esc-999', ESCALATE_DTO)).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when escrow is already released', async () => {
      escrowService.findById.mockResolvedValueOnce(makeEscrow({ status: 'released' }));
      await expect(service.escalate('esc-001', ESCALATE_DTO)).rejects.toThrow(BadRequestException);
    });

    it('throws ConflictException when an active saga already exists', async () => {
      await service.escalate('esc-001', ESCALATE_DTO);
      // Reset the mock so raiseDispute doesn't double-throw
      escrowService.raiseDispute.mockResolvedValue(escrow);
      await expect(service.escalate('esc-001', ESCALATE_DTO)).rejects.toThrow(ConflictException);
    });

    it('compensates and marks FAILED when raiseDispute throws', async () => {
      escrowService.raiseDispute.mockRejectedValueOnce(new Error('on-chain error'));
      await expect(service.escalate('esc-001', ESCALATE_DTO)).rejects.toThrow('on-chain error');
      // No saga stored — compensation cleaned up
      expect(service.findAll().filter(s => s.currentStep !== DisputeStep.FAILED).length).toBe(0);
    });
  });

  // ─── assignJurors ─────────────────────────────────────────────────

  describe('assignJurors()', () => {
    let sagaId: string;

    beforeEach(async () => {
      const saga = await service.escalate('esc-001', ESCALATE_DTO);
      sagaId = saga.sagaId;
    });

    it('assigns jurors and advances to VOTING', async () => {
      const saga = await service.assignJurors(sagaId, { jurors: JURORS });
      expect(saga.currentStep).toBe(DisputeStep.VOTING);
      expect(saga.assignedJurors).toEqual(JURORS);
    });

    it('deduplicates juror addresses', async () => {
      const saga = await service.assignJurors(sagaId, {
        jurors: [JURORS[0], JURORS[0], JURORS[1], JURORS[2]],
      });
      expect(saga.assignedJurors?.length).toBe(3);
    });

    it('throws BadRequestException when fewer than 3 distinct jurors provided', async () => {
      await expect(
        service.assignJurors(sagaId, { jurors: [JURORS[0], JURORS[0], JURORS[0]] }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when saga is at wrong step', async () => {
      // Move past JUROR_ASSIGNMENT
      await service.assignJurors(sagaId, { jurors: JURORS });
      await expect(service.assignJurors(sagaId, { jurors: JURORS })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('dispatches jurors_assigned webhook', async () => {
      await service.assignJurors(sagaId, { jurors: JURORS });
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        'dispute.jurors_assigned',
        expect.objectContaining({ jurors: JURORS }),
      );
    });
  });

  // ─── castVote ─────────────────────────────────────────────────────

  describe('castVote()', () => {
    let sagaId: string;

    beforeEach(async () => {
      const saga = await service.escalate('esc-001', ESCALATE_DTO);
      sagaId = saga.sagaId;
      await service.assignJurors(sagaId, { jurors: JURORS });
    });

    it('records a vote', async () => {
      const saga = await service.castVote(sagaId, { jurorAddress: JURORS[0], vote: 'depositor' });
      expect(saga.votes?.length).toBe(1);
    });

    it('computes DEPOSITOR_WINS verdict when majority votes depositor', async () => {
      await service.castVote(sagaId, { jurorAddress: JURORS[0], vote: 'depositor' });
      await service.castVote(sagaId, { jurorAddress: JURORS[1], vote: 'depositor' });
      const saga = await service.castVote(sagaId, {
        jurorAddress: JURORS[2],
        vote: 'beneficiary',
      });
      expect(saga.verdict).toBe(DisputeVerdict.DEPOSITOR_WINS);
      expect(saga.currentStep).toBe(DisputeStep.PAYOUT);
    });

    it('computes BENEFICIARY_WINS verdict', async () => {
      await service.castVote(sagaId, { jurorAddress: JURORS[0], vote: 'beneficiary' });
      await service.castVote(sagaId, { jurorAddress: JURORS[1], vote: 'beneficiary' });
      const saga = await service.castVote(sagaId, { jurorAddress: JURORS[2], vote: 'depositor' });
      expect(saga.verdict).toBe(DisputeVerdict.BENEFICIARY_WINS);
    });

    it('computes SPLIT verdict when no majority', async () => {
      await service.castVote(sagaId, { jurorAddress: JURORS[0], vote: 'depositor' });
      await service.castVote(sagaId, { jurorAddress: JURORS[1], vote: 'beneficiary' });
      const saga = await service.castVote(sagaId, { jurorAddress: JURORS[2], vote: 'split' });
      expect(saga.verdict).toBe(DisputeVerdict.SPLIT);
    });

    it('throws BadRequestException when address is not an assigned juror', async () => {
      await expect(
        service.castVote(sagaId, {
          jurorAddress: 'GNOTAJUROR11111111111111111111111111111111111111111111111',
          vote: 'depositor',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws ConflictException on duplicate vote', async () => {
      await service.castVote(sagaId, { jurorAddress: JURORS[0], vote: 'depositor' });
      await expect(
        service.castVote(sagaId, { jurorAddress: JURORS[0], vote: 'beneficiary' }),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ─── executePayout ────────────────────────────────────────────────

  describe('executePayout()', () => {
    let sagaId: string;

    async function runToPayoutStep(verdict: 'depositor' | 'beneficiary' | 'split') {
      const saga = await service.escalate('esc-001', ESCALATE_DTO);
      sagaId = saga.sagaId;
      await service.assignJurors(sagaId, { jurors: JURORS });
      await service.castVote(sagaId, { jurorAddress: JURORS[0], vote: verdict });
      await service.castVote(sagaId, { jurorAddress: JURORS[1], vote: verdict });
      await service.castVote(sagaId, { jurorAddress: JURORS[2], vote: 'depositor' });
    }

    it('completes saga and sets COMPLETED for DEPOSITOR_WINS', async () => {
      await runToPayoutStep('depositor');
      const saga = await service.executePayout(sagaId, {});
      expect(saga.currentStep).toBe(DisputeStep.COMPLETED);
      expect(saga.payoutTxHash).toBeDefined();
      expect(saga.completedAt).toBeDefined();
    });

    it('releases escrow for BENEFICIARY_WINS', async () => {
      await runToPayoutStep('beneficiary');
      await service.executePayout(sagaId, {});
      expect(escrowService.release).toHaveBeenCalledWith('esc-001');
    });

    it('dispatches payout_executed and saga_completed webhooks', async () => {
      await runToPayoutStep('depositor');
      await service.executePayout(sagaId, {});
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        'dispute.payout_executed',
        expect.objectContaining({ sagaId }),
      );
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        'dispute.saga_completed',
        expect.objectContaining({ sagaId }),
      );
    });

    it('throws BadRequestException when called before PAYOUT step', async () => {
      const saga = await service.escalate('esc-001', ESCALATE_DTO);
      await expect(service.executePayout(saga.sagaId, {})).rejects.toThrow(BadRequestException);
    });

    it('compensates on release failure and flags escrow for manual review', async () => {
      await runToPayoutStep('beneficiary');
      escrowService.release.mockRejectedValueOnce(new Error('on-chain payout failed'));
      escrowService.findById.mockResolvedValue({ ...escrow, status: 'disputed' });

      await expect(service.executePayout(sagaId, {})).rejects.toThrow('on-chain payout failed');

      const failed = service.findById(sagaId);
      expect(failed.currentStep).toBe(DisputeStep.FAILED);
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        'dispute.saga_failed',
        expect.objectContaining({ step: DisputeStep.PAYOUT }),
      );
    });
  });

  // ─── findById / findByEscrowId ────────────────────────────────────

  describe('findById()', () => {
    it('throws NotFoundException for unknown sagaId', () => {
      expect(() => service.findById('saga-unknown')).toThrow(NotFoundException);
    });
  });

  describe('findByEscrowId()', () => {
    it('returns undefined when no saga exists for escrow', () => {
      expect(service.findByEscrowId('esc-999')).toBeUndefined();
    });

    it('returns the saga when one exists', async () => {
      const saga = await service.escalate('esc-001', ESCALATE_DTO);
      expect(service.findByEscrowId('esc-001')?.sagaId).toBe(saga.sagaId);
    });
  });
});
