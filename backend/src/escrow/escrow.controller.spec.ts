import { Test, TestingModule } from '@nestjs/testing';
import { EscrowController } from './escrow.controller';
import { EscrowService } from './escrow.service';
import { WebhookService } from '../webhook/webhook.service';
import { DiscordService } from '../webhook/discord.service';
import { ReputationService } from '../reputation/reputation.service';

describe('EscrowController', () => {
  let controller: EscrowController;

  const mockEscrowService = {
    create: jest.fn(),
    findById: jest.fn(),
    findByDepositor: jest.fn(),
    release: jest.fn(),
    raiseDispute: jest.fn(),
  };
  const mockWebhookService = { dispatch: jest.fn().mockResolvedValue(undefined) };
  const mockDiscordService = { notifyDisputeNeedsJurors: jest.fn().mockResolvedValue(undefined) };
  const mockReputationService = { recordEscrowCompleted: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [EscrowController],
      providers: [
        { provide: EscrowService, useValue: mockEscrowService },
        { provide: WebhookService, useValue: mockWebhookService },
        { provide: DiscordService, useValue: mockDiscordService },
        { provide: ReputationService, useValue: mockReputationService },
      ],
    }).compile();

    controller = module.get<EscrowController>(EscrowController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('release', () => {
    it('releases the escrow and records the completion with the reputation engine', async () => {
      const escrow = {
        id: 'esc-1',
        depositor: 'GDEP',
        beneficiary: 'GBEN',
        amountXLM: '100',
        status: 'released',
        createdAt: new Date().toISOString(),
      };
      mockEscrowService.release.mockResolvedValue(escrow);

      const result = await controller.release('esc-1');

      expect(mockEscrowService.release).toHaveBeenCalledWith('esc-1');
      expect(mockReputationService.recordEscrowCompleted).toHaveBeenCalledWith(escrow);
      expect(result).toEqual(escrow);
    });
  });

  describe('raiseDispute', () => {
    it('does not record a reputation completion for a disputed escrow', async () => {
      const escrow = {
        id: 'esc-1',
        depositor: 'GDEP',
        beneficiary: 'GBEN',
        amountXLM: '100',
        status: 'disputed',
        disputeReason: 'not delivered',
        disputedAt: new Date().toISOString(),
      };
      mockEscrowService.raiseDispute.mockResolvedValue(escrow);

      await controller.raiseDispute('esc-1', { reason: 'not delivered' });

      expect(mockReputationService.recordEscrowCompleted).not.toHaveBeenCalled();
      expect(mockWebhookService.dispatch).toHaveBeenCalled();
      expect(mockDiscordService.notifyDisputeNeedsJurors).toHaveBeenCalled();
    });
  });
});
