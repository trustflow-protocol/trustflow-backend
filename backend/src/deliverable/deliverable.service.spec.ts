import { Test, TestingModule } from '@nestjs/testing';
import { DeliverableService } from './deliverable.service';
import { IpfsPinningService } from '../ipfs-pinning/ipfs-pinning.service';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { UploadDeliverableDto } from './deliverable.dto';
import { DeliverableStatus } from './deliverable.entity';

describe('DeliverableService', () => {
  let service: DeliverableService;

  const mockIpfsPinningService = {
    pinContent: jest.fn(),
  };

  const mockRedis = null;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeliverableService,
        { provide: IpfsPinningService, useValue: mockIpfsPinningService },
        { provide: REDIS_CLIENT, useValue: mockRedis },
      ],
    }).compile();

    service = module.get<DeliverableService>(DeliverableService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('upload', () => {
    const dto: UploadDeliverableDto = {
      gigId: 'gig-1',
      freelancer: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      content: Buffer.from('test file').toString('base64'),
      filename: 'report.pdf',
    };

    it('pins content to IPFS and stores the deliverable', async () => {
      mockIpfsPinningService.pinContent.mockResolvedValue({
        cid: 'bafytest123',
        size: 9,
      });

      const result = await service.upload(dto);

      expect(result.gigId).toBe('gig-1');
      expect(result.cid).toBe('bafytest123');
      expect(result.filename).toBe('report.pdf');
      expect(result.status).toBe(DeliverableStatus.PINNED);
      expect(mockIpfsPinningService.pinContent).toHaveBeenCalledWith({
        content: dto.content,
        filename: dto.filename,
      });
    });

    it('can retrieve uploaded deliverable by ID', async () => {
      mockIpfsPinningService.pinContent.mockResolvedValue({
        cid: 'bafytest456',
        size: 20,
      });

      const created = await service.upload(dto);
      const found = await service.findById(created.id);

      expect(found.id).toBe(created.id);
      expect(found.cid).toBe('bafytest456');
    });

    it('returns deliverables filtered by gig ID', async () => {
      mockIpfsPinningService.pinContent.mockResolvedValue({ cid: 'c1', size: 1 });

      await service.upload({ ...dto, gigId: 'gig-1' });
      await service.upload({ ...dto, gigId: 'gig-2' });
      const gig1Deliverables = await service.findByGig('gig-1');

      expect(gig1Deliverables).toHaveLength(1);
      expect(gig1Deliverables[0].gigId).toBe('gig-1');
    });
  });
});
