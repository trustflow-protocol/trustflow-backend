import { Test, TestingModule } from '@nestjs/testing';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

describe('AdminController', () => {
  let controller: AdminController;

  const mockService = {
    getOverview: jest.fn(),
    getEscrowAnalytics: jest.fn(),
    getGigAnalytics: jest.fn(),
    getDisputeAnalytics: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [{ provide: AdminService, useValue: mockService }],
    }).compile();

    controller = module.get<AdminController>(AdminController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('getOverview delegates to the service', async () => {
    mockService.getOverview.mockResolvedValue({ generatedAt: '2026-01-01T00:00:00.000Z' });
    expect(await controller.getOverview()).toEqual({ generatedAt: '2026-01-01T00:00:00.000Z' });
    expect(mockService.getOverview).toHaveBeenCalled();
  });

  it('getEscrowAnalytics delegates to the service', async () => {
    mockService.getEscrowAnalytics.mockResolvedValue({ total: 1 });
    expect(await controller.getEscrowAnalytics()).toEqual({ total: 1 });
  });

  it('getGigAnalytics delegates to the service', async () => {
    mockService.getGigAnalytics.mockResolvedValue({ total: 2 });
    expect(await controller.getGigAnalytics()).toEqual({ total: 2 });
  });

  it('getDisputeAnalytics delegates to the service', async () => {
    mockService.getDisputeAnalytics.mockReturnValue({ total: 3 });
    expect(await controller.getDisputeAnalytics()).toEqual({ total: 3 });
  });
});
