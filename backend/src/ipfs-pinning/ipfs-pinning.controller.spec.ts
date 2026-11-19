import { Test, TestingModule } from '@nestjs/testing';
import { IpfsPinningController } from './ipfs-pinning.controller';
import { IpfsPinningService } from './ipfs-pinning.service';
import { validateEnv } from '../config/env.config';

describe('IpfsPinningController', () => {
  let controller: IpfsPinningController;

  const mockService = {
    pinContent: jest.fn(),
    findAll: jest.fn(),
    findByCid: jest.fn(),
    reconcile: jest.fn(),
    unpin: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret-at-least-16-chars';
    validateEnv();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [IpfsPinningController],
      providers: [{ provide: IpfsPinningService, useValue: mockService }],
    }).compile();

    controller = module.get<IpfsPinningController>(IpfsPinningController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('pin delegates to the service', () => {
    const dto = { content: 'aGVsbG8=' };
    mockService.pinContent.mockReturnValue({ cid: 'bafkreitest' });

    expect(controller.pin(dto)).toEqual({ cid: 'bafkreitest' });
    expect(mockService.pinContent).toHaveBeenCalledWith(dto);
  });

  it('findAll delegates to the service', () => {
    mockService.findAll.mockReturnValue([{ cid: 'bafkreitest' }]);
    expect(controller.findAll()).toEqual([{ cid: 'bafkreitest' }]);
  });

  it('findOne delegates to the service with the cid', () => {
    mockService.findByCid.mockReturnValue({ cid: 'bafkreitest' });
    expect(controller.findOne('bafkreitest')).toEqual({ cid: 'bafkreitest' });
    expect(mockService.findByCid).toHaveBeenCalledWith('bafkreitest');
  });

  it('verify delegates to the service reconcile method', () => {
    mockService.reconcile.mockReturnValue({ cid: 'bafkreitest', status: 'HEALTHY' });
    expect(controller.verify('bafkreitest')).toEqual({ cid: 'bafkreitest', status: 'HEALTHY' });
    expect(mockService.reconcile).toHaveBeenCalledWith('bafkreitest');
  });

  it('unpin delegates to the service', () => {
    mockService.unpin.mockReturnValue({ cid: 'bafkreitest', status: 'UNPINNED' });
    expect(controller.unpin('bafkreitest')).toEqual({ cid: 'bafkreitest', status: 'UNPINNED' });
    expect(mockService.unpin).toHaveBeenCalledWith('bafkreitest');
  });
});
