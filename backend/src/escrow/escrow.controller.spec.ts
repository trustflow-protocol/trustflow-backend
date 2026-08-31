import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { EscrowController } from './escrow.controller';
import { EscrowService } from './escrow.service';
import { WebhookService } from '../webhook/webhook.service';
import { DiscordService } from '../webhook/discord.service';
import { ReputationService } from '../reputation/reputation.service';
import { EscrowReleaseTransactionBuilderService } from '../escrow-write/escrow-release-transaction-builder.service';
import { WebhookEvent } from '../webhook/webhook.dto';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const DEPOSITOR = 'GDEPOSITOR111111111111111111111111111111111111111111111';
const BENEFICIARY = 'GBENEFICIARY1111111111111111111111111111111111111111111';
const AMOUNT = '100';

function makeEscrow(overrides: Partial<any> = {}) {
  return {
    id: 'esc-001',
    depositor: DEPOSITOR,
    beneficiary: BENEFICIARY,
    amountXLM: AMOUNT,
    status: 'active',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Mock factories ───────────────────────────────────────────────────────────

function buildMocks() {
  const escrow = makeEscrow();

  const escrowService = {
    create: jest.fn().mockResolvedValue(escrow),
    findById: jest.fn().mockResolvedValue(escrow),
    findByDepositor: jest.fn().mockResolvedValue([escrow]),
    release: jest.fn().mockResolvedValue({ ...escrow, status: 'released' }),
    raiseDispute: jest.fn().mockResolvedValue({
      ...escrow,
      status: 'disputed',
      disputeReason: 'Work not delivered',
      disputedAt: new Date().toISOString(),
    }),
  };

  const webhookService = {
    dispatch: jest.fn().mockResolvedValue(undefined),
  };

  const discordService = {
    notifyDisputeNeedsJurors: jest.fn().mockResolvedValue(undefined),
  };

  const reputationService = {
    recordEscrowCompleted: jest.fn().mockResolvedValue(undefined),
  };

  const txBuilderService = {
    buildRelease: jest.fn().mockResolvedValue({
      xdr: 'AAAAAgAAAAA...',
      network: 'TESTNET',
      networkPassphrase: 'Test SDF Network ; September 2015',
      contractId: 'CXXX',
      sourceAccount: DEPOSITOR,
    }),
  };

  return { escrow, escrowService, webhookService, discordService, reputationService, txBuilderService };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('EscrowController', () => {
  let controller: EscrowController;
  let mocks: ReturnType<typeof buildMocks>;

  beforeEach(async () => {
    jest.clearAllMocks();
    mocks = buildMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [EscrowController],
      providers: [
        { provide: EscrowService, useValue: mocks.escrowService },
        { provide: WebhookService, useValue: mocks.webhookService },
        { provide: DiscordService, useValue: mocks.discordService },
        { provide: ReputationService, useValue: mocks.reputationService },
        {
          provide: EscrowReleaseTransactionBuilderService,
          useValue: mocks.txBuilderService,
        },
      ],
    }).compile();

    controller = module.get<EscrowController>(EscrowController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  // ─── POST /escrows (create) ───────────────────────────────────────────────

  describe('create()', () => {
    it('delegates to EscrowService.create() and returns the new escrow', async () => {
      const dto = { depositor: DEPOSITOR, beneficiary: BENEFICIARY, amountXLM: AMOUNT };

      const result = controller.create(dto);

      expect(mocks.escrowService.create).toHaveBeenCalledWith(
        DEPOSITOR,
        BENEFICIARY,
        AMOUNT,
      );
      expect(result).toEqual(mocks.escrow);
    });
  });

  // ─── GET /escrows/:id (findOne) ───────────────────────────────────────────

  describe('findOne()', () => {
    it('delegates to EscrowService.findById() and returns the escrow', () => {
      const result = controller.findOne('esc-001');

      expect(mocks.escrowService.findById).toHaveBeenCalledWith('esc-001');
      expect(result).toEqual(mocks.escrow);
    });

    it('returns undefined for an unknown escrow id (service returns undefined)', () => {
      mocks.escrowService.findById.mockReturnValue(undefined);

      const result = controller.findOne('esc-unknown');

      expect(result).toBeUndefined();
    });
  });

  // ─── GET /escrows/depositor/:address ──────────────────────────────────────

  describe('findByDepositor()', () => {
    it('delegates to EscrowService.findByDepositor() with the address', () => {
      const result = controller.findByDepositor(DEPOSITOR);

      expect(mocks.escrowService.findByDepositor).toHaveBeenCalledWith(DEPOSITOR);
      expect(result).toEqual([mocks.escrow]);
    });

    it('returns an empty array when no escrows exist for the depositor', () => {
      mocks.escrowService.findByDepositor.mockReturnValue([]);

      expect(controller.findByDepositor(DEPOSITOR)).toEqual([]);
    });
  });

  // ─── POST /escrows/:id/release ────────────────────────────────────────────

  describe('release()', () => {
    it('releases the escrow, records reputation, and returns the updated escrow', async () => {
      const released = { ...mocks.escrow, status: 'released' };
      mocks.escrowService.release.mockResolvedValue(released);

      const result = await controller.release('esc-001');

      expect(mocks.escrowService.release).toHaveBeenCalledWith('esc-001');
      expect(mocks.reputationService.recordEscrowCompleted).toHaveBeenCalledWith(released);
      expect(result).toEqual(released);
    });

    it('propagates errors thrown by EscrowService.release()', async () => {
      mocks.escrowService.release.mockRejectedValue(new Error('Escrow not found'));

      await expect(controller.release('esc-unknown')).rejects.toThrow('Escrow not found');
    });
  });

  // ─── POST /escrows/:id/dispute ────────────────────────────────────────────

  describe('raiseDispute()', () => {
    it('calls EscrowService.raiseDispute(), dispatches webhook, sends Discord notification, and returns the escrow', async () => {
      const disputed = makeEscrow({
        status: 'disputed',
        disputeReason: 'Work not delivered',
        disputedAt: new Date().toISOString(),
      });
      mocks.escrowService.raiseDispute.mockResolvedValue(disputed);

      const result = await controller.raiseDispute('esc-001', { reason: 'Work not delivered' });

      expect(mocks.escrowService.raiseDispute).toHaveBeenCalledWith('esc-001', 'Work not delivered');

      expect(mocks.webhookService.dispatch).toHaveBeenCalledWith(
        WebhookEvent.DisputeRaised,
        expect.objectContaining({
          escrowId: disputed.id,
          depositor: disputed.depositor,
          beneficiary: disputed.beneficiary,
          amountXLM: disputed.amountXLM,
          reason: disputed.disputeReason,
          disputedAt: disputed.disputedAt,
        }),
      );

      expect(mocks.discordService.notifyDisputeNeedsJurors).toHaveBeenCalledWith(
        expect.objectContaining({
          escrowId: disputed.id,
          depositor: disputed.depositor,
          beneficiary: disputed.beneficiary,
          amountXLM: disputed.amountXLM,
          reason: disputed.disputeReason,
        }),
      );

      expect(result).toEqual(disputed);
    });

    it('works when no reason is provided in the dto', async () => {
      mocks.escrowService.raiseDispute.mockResolvedValue(
        makeEscrow({ status: 'disputed' }),
      );

      await controller.raiseDispute('esc-001', {});

      expect(mocks.escrowService.raiseDispute).toHaveBeenCalledWith('esc-001', undefined);
    });

    it('propagates BadRequestException when escrow is already released', async () => {
      const { BadRequestException } = jest.requireActual('@nestjs/common');
      mocks.escrowService.raiseDispute.mockRejectedValue(
        new BadRequestException('Cannot dispute a released escrow'),
      );

      await expect(
        controller.raiseDispute('esc-001', { reason: 'too late' }),
      ).rejects.toThrow(BadRequestException);

      expect(mocks.webhookService.dispatch).not.toHaveBeenCalled();
      expect(mocks.discordService.notifyDisputeNeedsJurors).not.toHaveBeenCalled();
    });

    it('propagates BadRequestException when escrow is already disputed', async () => {
      const { BadRequestException } = jest.requireActual('@nestjs/common');
      mocks.escrowService.raiseDispute.mockRejectedValue(
        new BadRequestException('Escrow is already disputed'),
      );

      await expect(
        controller.raiseDispute('esc-001', { reason: 'dupe' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('does not dispatch webhook or Discord when service throws', async () => {
      mocks.escrowService.raiseDispute.mockRejectedValue(new Error('unexpected'));

      await expect(controller.raiseDispute('esc-001', {})).rejects.toThrow();

      expect(mocks.webhookService.dispatch).not.toHaveBeenCalled();
      expect(mocks.discordService.notifyDisputeNeedsJurors).not.toHaveBeenCalled();
    });
  });

  // ─── GET /escrows/:id/release/transaction ────────────────────────────────

  describe('buildReleaseTransaction()', () => {
    it('calls the tx builder with contractEscrowId and sourceAccount', async () => {
      const linked = makeEscrow({ contractEscrowId: 'on-chain-id-001' });
      mocks.escrowService.findById.mockResolvedValue(linked);

      const result = await controller.buildReleaseTransaction('esc-001', {
        sourceAccount: DEPOSITOR,
      } as any);

      expect(mocks.txBuilderService.buildRelease).toHaveBeenCalledWith(
        'on-chain-id-001',
        DEPOSITOR,
      );
      expect(result).toHaveProperty('xdr');
    });

    it('throws NotFoundException when the escrow does not exist', async () => {
      mocks.escrowService.findById.mockResolvedValue(undefined);

      await expect(
        controller.buildReleaseTransaction('esc-ghost', { sourceAccount: DEPOSITOR } as any),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when the escrow has no contractEscrowId', async () => {
      const unlinked = makeEscrow({ contractEscrowId: undefined });
      mocks.escrowService.findById.mockResolvedValue(unlinked);

      await expect(
        controller.buildReleaseTransaction('esc-001', { sourceAccount: DEPOSITOR } as any),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
