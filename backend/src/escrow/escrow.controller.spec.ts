import { INestApplication, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { EscrowController } from './escrow.controller';
import { EscrowService } from './escrow.service';
import { WebhookService } from '../webhook/webhook.service';
import { DiscordService } from '../webhook/discord.service';
import { ReputationService } from '../reputation/reputation.service';
import { EscrowReleaseTransactionBuilderService } from '../escrow-write/escrow-release-transaction-builder.service';

const VALID_ADDRESS = 'GDC2E5ZAK6GNTLIZDJBHKGS24UCF6AH7KVKNP3JSJ4UDTZREA3BANGFS';

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
  const mockEscrowReleaseTransactionBuilderService = { buildRelease: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [EscrowController],
      providers: [
        { provide: EscrowService, useValue: mockEscrowService },
        { provide: WebhookService, useValue: mockWebhookService },
        { provide: DiscordService, useValue: mockDiscordService },
        { provide: ReputationService, useValue: mockReputationService },
        {
          provide: EscrowReleaseTransactionBuilderService,
          useValue: mockEscrowReleaseTransactionBuilderService,
        },
      ],
    }).compile();

    controller = module.get<EscrowController>(EscrowController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('findByDepositor', () => {
    it('returns paginated results with default offset=0, limit=20', async () => {
      const escrows = Array.from({ length: 5 }, (_, i) => ({
        id: `esc-${i}`,
        depositor: VALID_ADDRESS,
        beneficiary: 'GBEN',
        amountXLM: '100',
        status: 'pending',
        createdAt: new Date().toISOString(),
      }));
      mockEscrowService.findByDepositor.mockResolvedValue({ data: escrows, total: 5 });

      const result = await controller.findByDepositor(VALID_ADDRESS);

      expect(mockEscrowService.findByDepositor).toHaveBeenCalledWith(VALID_ADDRESS, 0, 20);
      expect(result).toEqual({ data: escrows, total: 5 });
    });

    it('applies custom offset and limit', async () => {
      mockEscrowService.findByDepositor.mockResolvedValue({ data: [], total: 0 });

      await controller.findByDepositor(VALID_ADDRESS, 10, 5);

      expect(mockEscrowService.findByDepositor).toHaveBeenCalledWith(VALID_ADDRESS, 10, 5);
    });

    it('clamps limit to max 100', async () => {
      mockEscrowService.findByDepositor.mockResolvedValue({ data: [], total: 0 });

      await controller.findByDepositor(VALID_ADDRESS, 0, 200);

      expect(mockEscrowService.findByDepositor).toHaveBeenCalledWith(VALID_ADDRESS, 0, 100);
    });

    it('clamps negative offset to 0', async () => {
      mockEscrowService.findByDepositor.mockResolvedValue({ data: [], total: 0 });

      await controller.findByDepositor(VALID_ADDRESS, -5, 10);

      expect(mockEscrowService.findByDepositor).toHaveBeenCalledWith(VALID_ADDRESS, 0, 10);
    });
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

  describe('buildReleaseTransaction', () => {
    it('404s when the escrow does not exist', async () => {
      mockEscrowService.findById.mockResolvedValue(undefined);

      await expect(
        controller.buildReleaseTransaction('esc-missing', { sourceAccount: VALID_ADDRESS }),
      ).rejects.toThrow(NotFoundException);
    });

    it('404s when the escrow has not been linked to an on-chain escrow yet', async () => {
      mockEscrowService.findById.mockResolvedValue({ id: 'esc-1', status: 'active' });

      await expect(
        controller.buildReleaseTransaction('esc-1', { sourceAccount: VALID_ADDRESS }),
      ).rejects.toThrow(NotFoundException);
      expect(mockEscrowReleaseTransactionBuilderService.buildRelease).not.toHaveBeenCalled();
    });

    it('delegates to the transaction builder for a chain-linked escrow', async () => {
      mockEscrowService.findById.mockResolvedValue({
        id: 'esc-1',
        status: 'active',
        contractEscrowId: 'chain-esc-1',
      });
      const unsignedTx = { xdr: 'AAAA...', network: 'TESTNET' };
      mockEscrowReleaseTransactionBuilderService.buildRelease.mockResolvedValue(unsignedTx);

      const result = await controller.buildReleaseTransaction('esc-1', {
        sourceAccount: VALID_ADDRESS,
      });

      expect(mockEscrowReleaseTransactionBuilderService.buildRelease).toHaveBeenCalledWith(
        'chain-esc-1',
        VALID_ADDRESS,
      );
      expect(result).toEqual(unsignedTx);
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

describe('EscrowController Supertest integration', () => {
  let app: INestApplication;

  const mockEscrowService = {
    findById: jest.fn(),
  };
  const mockEscrowReleaseTransactionBuilderService = { buildRelease: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [EscrowController],
      providers: [
        { provide: EscrowService, useValue: mockEscrowService },
        { provide: WebhookService, useValue: { dispatch: jest.fn() } },
        { provide: DiscordService, useValue: { notifyDisputeNeedsJurors: jest.fn() } },
        { provide: ReputationService, useValue: { recordEscrowCompleted: jest.fn() } },
        {
          provide: EscrowReleaseTransactionBuilderService,
          useValue: mockEscrowReleaseTransactionBuilderService,
        },
      ],
    }).compile();

    app = module.createNestApplication();
    // Mirrors the ValidationPipe registered in main.ts's bootstrap().
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /escrows/:id/release/transaction rejects a malformed sourceAccount with 400, before any service is called', async () => {
    await request(app.getHttpServer())
      .get('/escrows/esc-1/release/transaction')
      .query({ sourceAccount: 'not-an-address' })
      .expect(400);

    expect(mockEscrowService.findById).not.toHaveBeenCalled();
  });

  it('GET /escrows/:id/release/transaction rejects a missing sourceAccount with 400', async () => {
    await request(app.getHttpServer()).get('/escrows/esc-1/release/transaction').expect(400);

    expect(mockEscrowService.findById).not.toHaveBeenCalled();
  });

  it('GET /escrows/:id/release/transaction returns the unsigned XDR for a valid, chain-linked escrow', async () => {
    mockEscrowService.findById.mockResolvedValue({
      id: 'esc-1',
      status: 'active',
      contractEscrowId: 'chain-esc-1',
    });
    mockEscrowReleaseTransactionBuilderService.buildRelease.mockResolvedValue({
      xdr: 'AAAA...',
      network: 'TESTNET',
    });

    const response = await request(app.getHttpServer())
      .get('/escrows/esc-1/release/transaction')
      .query({ sourceAccount: VALID_ADDRESS })
      .expect(200);

    expect(response.body).toEqual({ xdr: 'AAAA...', network: 'TESTNET' });
    expect(mockEscrowReleaseTransactionBuilderService.buildRelease).toHaveBeenCalledWith(
      'chain-esc-1',
      VALID_ADDRESS,
    );
  });
});
