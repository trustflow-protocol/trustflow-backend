import { Test, TestingModule } from '@nestjs/testing';
import { GigController } from './gig.controller';
import { GigService } from './gig.service';
import { WebhookService } from '../webhook/webhook.service';
import { GIG_EVENTS, GigStatus } from './gig.entity';

describe('GigController', () => {
  let controller: GigController;

  const mockGigService = {
    create: jest.fn(),
    findById: jest.fn(),
    findByCreator: jest.fn(),
    accept: jest.fn(),
    cancel: jest.fn(),
  };

  const mockWebhookService = {
    dispatch: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockWebhookService.dispatch.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [GigController],
      providers: [
        { provide: GigService, useValue: mockGigService },
        { provide: WebhookService, useValue: mockWebhookService },
      ],
    }).compile();

    controller = module.get<GigController>(GigController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('create', () => {
    const dto = {
      creator: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      title: 'Build a Soroban escrow audit report',
      budgetXLM: '250',
    };

    it('creates the gig via the service and dispatches a gig.created webhook', async () => {
      const gig = { id: 'gig-1', ...dto, status: GigStatus.OPEN };
      mockGigService.create.mockReturnValue(gig);

      const result = await controller.create(dto);

      expect(result).toEqual(gig);
      expect(mockGigService.create).toHaveBeenCalledWith(dto);
      expect(mockWebhookService.dispatch).toHaveBeenCalledWith(GIG_EVENTS.GIG_CREATED, gig);
    });

    it('rejects an invalid creator address before hitting the service', async () => {
      await expect(
        controller.create({ ...dto, creator: 'not-a-stellar-address' }),
      ).rejects.toThrow();
      expect(mockGigService.create).not.toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('delegates to the service', () => {
      mockGigService.findById.mockReturnValue({ id: 'gig-1' });
      expect(controller.findOne('gig-1')).toEqual({ id: 'gig-1' });
      expect(mockGigService.findById).toHaveBeenCalledWith('gig-1');
    });
  });

  describe('findByCreator', () => {
    it('delegates to the service', () => {
      mockGigService.findByCreator.mockReturnValue([{ id: 'gig-1' }]);
      const address = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

      expect(controller.findByCreator(address)).toEqual([{ id: 'gig-1' }]);
      expect(mockGigService.findByCreator).toHaveBeenCalledWith(address);
    });
  });

  describe('accept', () => {
    it('accepts via the service and dispatches a gig.accepted webhook', async () => {
      const responder = 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY';
      const gig = { id: 'gig-1', status: GigStatus.ACCEPTED, acceptedBy: responder };
      mockGigService.accept.mockReturnValue(gig);

      const result = await controller.accept('gig-1', { responder });

      expect(result).toEqual(gig);
      expect(mockGigService.accept).toHaveBeenCalledWith('gig-1', responder);
      expect(mockWebhookService.dispatch).toHaveBeenCalledWith(GIG_EVENTS.GIG_ACCEPTED, gig);
    });
  });

  describe('cancel', () => {
    it('cancels via the service and dispatches a gig.cancelled webhook', async () => {
      const gig = { id: 'gig-1', status: GigStatus.CANCELLED };
      mockGigService.cancel.mockReturnValue(gig);

      const result = await controller.cancel('gig-1');

      expect(result).toEqual(gig);
      expect(mockGigService.cancel).toHaveBeenCalledWith('gig-1');
      expect(mockWebhookService.dispatch).toHaveBeenCalledWith(GIG_EVENTS.GIG_CANCELLED, gig);
    });
  });
});
