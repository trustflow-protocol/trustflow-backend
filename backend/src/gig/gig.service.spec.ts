import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GigService } from './gig.service';
import { GigStatus } from './gig.entity';

describe('GigService', () => {
  let service: GigService;

  const validDto = {
    creator: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    title: 'Build a Soroban escrow audit report',
    budgetXLM: '250',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [GigService],
    }).compile();

    service = module.get<GigService>(GigService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('creates an open gig with a default 72h response deadline', () => {
      const before = Date.now();
      const gig = service.create(validDto);

      expect(gig.id).toBeDefined();
      expect(gig.creator).toBe(validDto.creator);
      expect(gig.title).toBe(validDto.title);
      expect(gig.budgetXLM).toBe(validDto.budgetXLM);
      expect(gig.status).toBe(GigStatus.OPEN);

      const expectedRespondBy = before + 72 * 60 * 60 * 1000;
      expect(new Date(gig.respondBy).getTime()).toBeGreaterThanOrEqual(expectedRespondBy - 1000);
    });

    it('honors a custom responseWindowHours', () => {
      const gig = service.create({ ...validDto, responseWindowHours: 1 });
      const createdAt = new Date(gig.createdAt).getTime();
      const respondBy = new Date(gig.respondBy).getTime();
      expect(respondBy - createdAt).toBe(60 * 60 * 1000);
    });
  });

  describe('findById', () => {
    it('throws NotFoundException for an unknown id', () => {
      expect(() => service.findById('missing')).toThrow(NotFoundException);
    });

    it('returns the gig when it exists', () => {
      const created = service.create(validDto);
      expect(service.findById(created.id)).toEqual(created);
    });
  });

  describe('findByCreator', () => {
    it('returns only gigs posted by the given creator', () => {
      const gig = service.create(validDto);
      service.create({
        ...validDto,
        creator: 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY',
      });

      const results = service.findByCreator(validDto.creator);
      expect(results).toEqual([gig]);
    });
  });

  describe('findExpirable', () => {
    it('excludes gigs whose response deadline has not passed', () => {
      service.create(validDto);
      expect(service.findExpirable()).toEqual([]);
    });

    it('includes only OPEN gigs whose response deadline has passed', () => {
      const gig = service.create({ ...validDto, responseWindowHours: 1 });
      const future = new Date(Date.now() + 2 * 60 * 60 * 1000);

      expect(service.findExpirable(future)).toEqual([gig]);
    });

    it('excludes gigs that are no longer OPEN even if their deadline passed', () => {
      const gig = service.create({ ...validDto, responseWindowHours: 1 });
      service.accept(gig.id, 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY');
      const future = new Date(Date.now() + 2 * 60 * 60 * 1000);

      expect(service.findExpirable(future)).toEqual([]);
    });
  });

  describe('accept', () => {
    it('marks an open gig as accepted', () => {
      const gig = service.create(validDto);
      const responder = 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY';

      const accepted = service.accept(gig.id, responder);

      expect(accepted.status).toBe(GigStatus.ACCEPTED);
      expect(accepted.acceptedBy).toBe(responder);
      expect(accepted.acceptedAt).toBeDefined();
    });

    it('throws when the gig is not open', () => {
      const gig = service.create(validDto);
      service.accept(gig.id, 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY');

      expect(() =>
        service.accept(gig.id, 'GZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'),
      ).toThrow(BadRequestException);
    });
  });

  describe('cancel', () => {
    it('marks an open gig as cancelled', () => {
      const gig = service.create(validDto);
      const cancelled = service.cancel(gig.id);

      expect(cancelled.status).toBe(GigStatus.CANCELLED);
      expect(cancelled.cancelledAt).toBeDefined();
    });

    it('throws when the gig is not open', () => {
      const gig = service.create(validDto);
      service.cancel(gig.id);

      expect(() => service.cancel(gig.id)).toThrow(BadRequestException);
    });
  });

  describe('expire', () => {
    it('marks an open gig as expired', () => {
      const gig = service.create(validDto);
      const expired = service.expire(gig.id);

      expect(expired?.status).toBe(GigStatus.EXPIRED);
      expect(expired?.expiredAt).toBeDefined();
    });

    it('is a no-op for a gig that is already resolved', () => {
      const gig = service.create(validDto);
      service.accept(gig.id, 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY');

      expect(service.expire(gig.id)).toBeUndefined();
      expect(service.findById(gig.id).status).toBe(GigStatus.ACCEPTED);
    });

    it('is a no-op for an unknown id', () => {
      expect(service.expire('missing')).toBeUndefined();
    });
  });
});
