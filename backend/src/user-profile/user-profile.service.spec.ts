import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { UserProfileService } from './user-profile.service';
import { UserType, UserStatus } from './user-profile.entity';

describe('UserProfileService', () => {
  let service: UserProfileService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [UserProfileService],
    }).compile();

    service = module.get<UserProfileService>(UserProfileService);
  });

  afterEach(() => {
    // Clear all profiles after each test
    service['profiles'].clear();
    service['walletAddressIndex'].clear();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    const validDto = {
      walletAddress: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      name: 'John Doe',
      bio: 'Experienced developer',
      userType: UserType.FREELANCER,
      skills: ['JavaScript', 'TypeScript'],
    };

    it('should create a new user profile', async () => {
      const profile = await service.create(validDto);

      expect(profile).toBeDefined();
      expect(profile.id).toBeDefined();
      expect(profile.walletAddress).toBe(validDto.walletAddress);
      expect(profile.name).toBe(validDto.name);
      expect(profile.bio).toBe(validDto.bio);
      expect(profile.userType).toBe(validDto.userType);
      expect(profile.skills).toEqual(validDto.skills);
      expect(profile.rating).toBe(0);
      expect(profile.ratingCount).toBe(0);
      expect(profile.completedJobs).toBe(0);
      expect(profile.status).toBe(UserStatus.ACTIVE);
      expect(profile.isVerified).toBe(false);
      expect(profile.createdAt).toBeDefined();
      expect(profile.updatedAt).toBeDefined();
    });

    it('should throw ConflictException for duplicate wallet address', async () => {
      await service.create(validDto);

      await expect(service.create(validDto)).rejects.toThrow(ConflictException);
    });
  });

  describe('findById', () => {
    it('should find a profile by ID', async () => {
      const created = await service.create({
        walletAddress: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        name: 'John Doe',
        userType: UserType.FREELANCER,
      });

      const found = await service.findById(created.id);

      expect(found).toBeDefined();
      expect(found.id).toBe(created.id);
      expect(found.name).toBe(created.name);
    });

    it('should throw NotFoundException for non-existent ID', async () => {
      await expect(service.findById('non-existent-id')).rejects.toThrow(NotFoundException);
    });
  });

  describe('findByWalletAddress', () => {
    it('should find a profile by wallet address', async () => {
      const walletAddress = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
      const created = await service.create({
        walletAddress,
        name: 'John Doe',
        userType: UserType.FREELANCER,
      });

      const found = await service.findByWalletAddress(walletAddress);

      expect(found).toBeDefined();
      expect(found.id).toBe(created.id);
      expect(found.walletAddress).toBe(walletAddress);
    });

    it('should throw NotFoundException for non-existent wallet address', async () => {
      await expect(service.findByWalletAddress('GYYYYYYYYYYYYYYYYYY')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findAll', () => {
    beforeEach(async () => {
      await service.create({
        walletAddress: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        name: 'Freelancer 1',
        userType: UserType.FREELANCER,
      });
      await service.create({
        walletAddress: 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY',
        name: 'Client 1',
        userType: UserType.CLIENT,
      });
      await service.create({
        walletAddress: 'GZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ',
        name: 'Both 1',
        userType: UserType.BOTH,
      });
    });

    it('should return all profiles without filters', async () => {
      const profiles = await service.findAll();
      expect(profiles).toHaveLength(3);
    });

    it('should filter by userType', async () => {
      const profiles = await service.findAll({ userType: UserType.FREELANCER });
      expect(profiles.length).toBeGreaterThanOrEqual(1);
      expect(profiles.every(p => p.userType === UserType.FREELANCER || p.userType === UserType.BOTH)).toBe(true);
    });

    it('should filter by status', async () => {
      const profiles = await service.findAll({ status: UserStatus.ACTIVE });
      expect(profiles).toHaveLength(3);
    });

    it('should filter by minRating', async () => {
      const profiles = await service.findAll({ minRating: 0 });
      expect(profiles).toHaveLength(3);
    });
  });

  describe('update', () => {
    it('should update a profile', async () => {
      const created = await service.create({
        walletAddress: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        name: 'John Doe',
        userType: UserType.FREELANCER,
      });

      const updated = await service.update(created.id, {
        name: 'Jane Doe',
        bio: 'Updated bio',
      });

      expect(updated.name).toBe('Jane Doe');
      expect(updated.bio).toBe('Updated bio');
      expect(updated.updatedAt).not.toBe(created.updatedAt);
    });

    it('should throw NotFoundException for non-existent profile', async () => {
      await expect(
        service.update('non-existent-id', { name: 'New Name' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('delete', () => {
    it('should delete a profile', async () => {
      const created = await service.create({
        walletAddress: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        name: 'John Doe',
        userType: UserType.FREELANCER,
      });

      await service.delete(created.id);

      await expect(service.findById(created.id)).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException for non-existent profile', async () => {
      await expect(service.delete('non-existent-id')).rejects.toThrow(NotFoundException);
    });
  });

  describe('rateUser', () => {
    it('should add a rating to a user profile', async () => {
      const created = await service.create({
        walletAddress: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        name: 'John Doe',
        userType: UserType.FREELANCER,
      });

      const rated = await service.rateUser(created.id, {
        walletAddress: 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY',
        rating: 5,
      });

      expect(rated.rating).toBe(5);
      expect(rated.ratingCount).toBe(1);
    });

    it('should calculate weighted average for multiple ratings', async () => {
      const created = await service.create({
        walletAddress: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        name: 'John Doe',
        userType: UserType.FREELANCER,
      });

      await service.rateUser(created.id, {
        walletAddress: 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY',
        rating: 5,
      });

      const rated = await service.rateUser(created.id, {
        walletAddress: 'GZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ',
        rating: 3,
      });

      expect(rated.rating).toBe(4); // (5 + 3) / 2 = 4
      expect(rated.ratingCount).toBe(2);
    });
  });

  describe('incrementCompletedJobs', () => {
    it('should increment completed jobs counter', async () => {
      const created = await service.create({
        walletAddress: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        name: 'John Doe',
        userType: UserType.FREELANCER,
      });

      const updated = await service.incrementCompletedJobs(created.id);

      expect(updated.completedJobs).toBe(1);
    });
  });

  describe('updateTotalEarned', () => {
    it('should update total earned amount', async () => {
      const created = await service.create({
        walletAddress: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        name: 'John Doe',
        userType: UserType.FREELANCER,
      });

      const updated = await service.updateTotalEarned(created.id, '100.5');

      expect(updated.totalEarned).toBe('100.5000000');
    });
  });

  describe('updateTotalSpent', () => {
    it('should update total spent amount', async () => {
      const created = await service.create({
        walletAddress: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        name: 'John Doe',
        userType: UserType.CLIENT,
      });

      const updated = await service.updateTotalSpent(created.id, '200.75');

      expect(updated.totalSpent).toBe('200.7500000');
    });
  });

  describe('verifyUser', () => {
    it('should verify a user profile', async () => {
      const created = await service.create({
        walletAddress: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        name: 'John Doe',
        userType: UserType.FREELANCER,
      });

      const verified = await service.verifyUser(created.id);

      expect(verified.isVerified).toBe(true);
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      await service.create({
        walletAddress: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        name: 'Blockchain Developer',
        bio: 'Experienced in Solidity',
        userType: UserType.FREELANCER,
        skills: ['Solidity', 'Rust'],
      });
      await service.create({
        walletAddress: 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY',
        name: 'Frontend Developer',
        bio: 'React expert',
        userType: UserType.FREELANCER,
        skills: ['React', 'TypeScript'],
      });
    });

    it('should search by name', async () => {
      const results = await service.search('blockchain');
      expect(results).toHaveLength(1);
      expect(results[0].name).toContain('Blockchain');
    });

    it('should search by bio', async () => {
      const results = await service.search('solidity');
      expect(results).toHaveLength(1);
      expect(results[0].bio).toContain('Solidity');
    });

    it('should search by skills', async () => {
      const results = await service.search('rust');
      expect(results).toHaveLength(1);
      expect(results[0].skills).toContain('Rust');
    });

    it('should return empty array for no matches', async () => {
      const results = await service.search('nonexistent');
      expect(results).toHaveLength(0);
    });
  });
});
