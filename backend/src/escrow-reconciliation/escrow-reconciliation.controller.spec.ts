import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { EscrowReconciliationController } from './escrow-reconciliation.controller';
import { EscrowReconciliationService } from './escrow-reconciliation.service';

describe('EscrowReconciliationController', () => {
  let controller: EscrowReconciliationController;

  const mockService = {
    reconcile: jest.fn(),
    findAll: jest.fn(),
    findById: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [EscrowReconciliationController],
      providers: [{ provide: EscrowReconciliationService, useValue: mockService }],
    }).compile();

    controller = module.get<EscrowReconciliationController>(EscrowReconciliationController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('run delegates to the service with the supplied candidate ids', async () => {
    mockService.reconcile.mockResolvedValue({ runId: 'recon-1' });

    const result = await controller.run({ contractEscrowIds: ['chain-esc-1'] });

    expect(mockService.reconcile).toHaveBeenCalledWith(['chain-esc-1']);
    expect(result).toEqual({ runId: 'recon-1' });
  });

  it('run defaults to no candidate ids when none are supplied', async () => {
    mockService.reconcile.mockResolvedValue({ runId: 'recon-1' });

    await controller.run({});

    expect(mockService.reconcile).toHaveBeenCalledWith([]);
  });

  it('listRuns delegates to the service', () => {
    mockService.findAll.mockReturnValue([{ runId: 'recon-1' }]);
    expect(controller.listRuns()).toEqual([{ runId: 'recon-1' }]);
  });

  it('getRun returns the run when found', () => {
    mockService.findById.mockReturnValue({ runId: 'recon-1' });
    expect(controller.getRun('recon-1')).toEqual({ runId: 'recon-1' });
    expect(mockService.findById).toHaveBeenCalledWith('recon-1');
  });

  it('getRun throws NotFoundException when the run does not exist', () => {
    mockService.findById.mockReturnValue(undefined);
    expect(() => controller.getRun('recon-missing')).toThrow(NotFoundException);
  });
});
