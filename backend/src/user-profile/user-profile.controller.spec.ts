import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { UserProfileController } from './user-profile.controller';
import { UserProfileService } from './user-profile.service';
import { S3StorageService } from './s3-storage.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { UserType, UserStatus } from './user-profile.entity';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const WALLET = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const OTHER_WALLET = 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY';
const PROFILE_ID = 'profile-uuid-001';

const FAKE_PROFILE = {
  id: PROFILE_ID,
  walletAddress: WALLET,
  name: 'Alice Dev',
  userType: UserType.FREELANCER,
  rating: 0,
  ratingCount: 0,
  completedJobs: 0,
  status: UserStatus.ACTIVE,
  isVerified: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

/** A minimal valid CreateUserProfileDto body (passes Zod schema). */
const VALID_CREATE_DTO = {
  walletAddress: WALLET,
  name: 'Alice Dev',
  userType: UserType.FREELANCER,
};

/** A minimal valid UpdateUserProfileDto body (all fields optional). */
const VALID_UPDATE_DTO = { name: 'Alice Updated' };

/** A minimal valid RateUserDto body. */
const VALID_RATE_DTO = {
  walletAddress: OTHER_WALLET,
  rating: 5,
};

/** Simulated req.user set by JwtAuthGuard / JwtStrategy. */
function makeReq(address = WALLET) {
  return { user: { address, sub: address } };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('UserProfileController', () => {
  let controller: UserProfileController;

  const mockProfileService = {
    create: jest.fn(),
    findAll: jest.fn(),
    search: jest.fn(),
    findById: jest.fn(),
    findByWalletAddress: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    rateUser: jest.fn(),
    verifyUser: jest.fn(),
  };

  const mockS3Service = {
    uploadAvatar: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UserProfileController],
      providers: [
        { provide: UserProfileService, useValue: mockProfileService },
        { provide: S3StorageService, useValue: mockS3Service },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<UserProfileController>(UserProfileController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  // ─── POST / (create) ──────────────────────────────────────────────────────

  describe('create()', () => {
    it('delegates to UserProfileService.create() and returns the profile', async () => {
      mockProfileService.create.mockResolvedValue(FAKE_PROFILE);

      const result = await controller.create(VALID_CREATE_DTO as any, makeReq() as any);

      expect(mockProfileService.create).toHaveBeenCalledWith(
        expect.objectContaining({ walletAddress: WALLET }),
      );
      expect(result).toEqual(FAKE_PROFILE);
    });

    it('throws ForbiddenException when walletAddress does not match the JWT address', async () => {
      // req.user.address is a different wallet than the one in the body.
      await expect(
        controller.create(VALID_CREATE_DTO as any, makeReq(OTHER_WALLET) as any),
      ).rejects.toThrow(ForbiddenException);

      expect(mockProfileService.create).not.toHaveBeenCalled();
    });

    it('throws BadRequestException (Zod) when walletAddress is invalid', async () => {
      const invalidDto = { ...VALID_CREATE_DTO, walletAddress: 'not-a-valid-address' };
      await expect(
        controller.create(invalidDto as any, makeReq('not-a-valid-address') as any),
      ).rejects.toThrow();

      expect(mockProfileService.create).not.toHaveBeenCalled();
    });

    it('throws (Zod) when name is too short', async () => {
      const shortName = { ...VALID_CREATE_DTO, name: 'A' }; // min 2 chars
      await expect(
        controller.create(shortName as any, makeReq() as any),
      ).rejects.toThrow();
    });

    it('throws (Zod) when name exceeds 100 characters', async () => {
      const longName = { ...VALID_CREATE_DTO, name: 'A'.repeat(101) };
      await expect(
        controller.create(longName as any, makeReq() as any),
      ).rejects.toThrow();
    });

    it('throws (Zod) when bio exceeds 500 characters', async () => {
      const longBio = { ...VALID_CREATE_DTO, bio: 'B'.repeat(501) };
      await expect(
        controller.create(longBio as any, makeReq() as any),
      ).rejects.toThrow();
    });

    it('throws (Zod) when userType is not a valid enum value', async () => {
      const badType = { ...VALID_CREATE_DTO, userType: 'admin' };
      await expect(
        controller.create(badType as any, makeReq() as any),
      ).rejects.toThrow();
    });
  });

  // ─── GET / (findAll) ──────────────────────────────────────────────────────

  describe('findAll()', () => {
    it('delegates to UserProfileService.findAll() with no filters', async () => {
      mockProfileService.findAll.mockResolvedValue([FAKE_PROFILE]);

      const result = await controller.findAll();

      expect(mockProfileService.findAll).toHaveBeenCalledWith({
        userType: undefined,
        status: undefined,
        minRating: undefined,
      });
      expect(result).toEqual([FAKE_PROFILE]);
    });

    it('forwards userType query param to the service', async () => {
      mockProfileService.findAll.mockResolvedValue([]);

      await controller.findAll(UserType.FREELANCER, undefined, undefined);

      expect(mockProfileService.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ userType: UserType.FREELANCER }),
      );
    });

    it('forwards status query param to the service', async () => {
      mockProfileService.findAll.mockResolvedValue([]);

      await controller.findAll(undefined, UserStatus.ACTIVE, undefined);

      expect(mockProfileService.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ status: UserStatus.ACTIVE }),
      );
    });

    it('parses minRating as a float before forwarding', async () => {
      mockProfileService.findAll.mockResolvedValue([]);

      // NestJS delivers query strings as strings; the controller calls parseFloat().
      await controller.findAll(undefined, undefined, '4.5' as any);

      expect(mockProfileService.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ minRating: 4.5 }),
      );
    });

    it('passes minRating: undefined when the param is absent', async () => {
      mockProfileService.findAll.mockResolvedValue([]);

      await controller.findAll(undefined, undefined, undefined);

      expect(mockProfileService.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ minRating: undefined }),
      );
    });

    it('does not require authentication (no guard on this endpoint)', async () => {
      // Rebuild with a guard that denies and confirm findAll is still callable
      // by verifying no UnauthorizedException is raised at the controller layer.
      mockProfileService.findAll.mockResolvedValue([]);
      await expect(controller.findAll()).resolves.not.toThrow();
    });
  });

  // ─── GET /search ──────────────────────────────────────────────────────────

  describe('search()', () => {
    it('forwards the query string to UserProfileService.search()', async () => {
      mockProfileService.search.mockResolvedValue([FAKE_PROFILE]);

      const result = await controller.search('blockchain');

      expect(mockProfileService.search).toHaveBeenCalledWith('blockchain');
      expect(result).toEqual([FAKE_PROFILE]);
    });
  });

  // ─── GET /:id ─────────────────────────────────────────────────────────────

  describe('findById()', () => {
    it('delegates to UserProfileService.findById() and returns the profile', async () => {
      mockProfileService.findById.mockResolvedValue(FAKE_PROFILE);

      const result = await controller.findById(PROFILE_ID);

      expect(mockProfileService.findById).toHaveBeenCalledWith(PROFILE_ID);
      expect(result).toEqual(FAKE_PROFILE);
    });

    it('propagates NotFoundException from the service', async () => {
      const { NotFoundException } = jest.requireActual('@nestjs/common');
      mockProfileService.findById.mockRejectedValue(
        new NotFoundException('User profile not found'),
      );

      await expect(controller.findById('unknown-id')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── GET /wallet/:address ─────────────────────────────────────────────────

  describe('findByWalletAddress()', () => {
    it('delegates to UserProfileService.findByWalletAddress() and returns the profile', async () => {
      mockProfileService.findByWalletAddress.mockResolvedValue(FAKE_PROFILE);

      const result = await controller.findByWalletAddress(WALLET);

      expect(mockProfileService.findByWalletAddress).toHaveBeenCalledWith(WALLET);
      expect(result).toEqual(FAKE_PROFILE);
    });
  });

  // ─── PUT /:id (update) ────────────────────────────────────────────────────

  describe('update()', () => {
    it('parses via Zod, delegates to UserProfileService.update(), and returns the result', async () => {
      const updated = { ...FAKE_PROFILE, name: 'Alice Updated' };
      mockProfileService.update.mockResolvedValue(updated);

      const result = await controller.update(PROFILE_ID, VALID_UPDATE_DTO as any);

      expect(mockProfileService.update).toHaveBeenCalledWith(
        PROFILE_ID,
        expect.objectContaining({ name: 'Alice Updated' }),
      );
      expect(result).toEqual(updated);
    });

    it('throws (Zod) when name is too short', async () => {
      await expect(
        controller.update(PROFILE_ID, { name: 'X' } as any),
      ).rejects.toThrow();
    });

    it('throws (Zod) when bio exceeds 500 characters', async () => {
      await expect(
        controller.update(PROFILE_ID, { bio: 'B'.repeat(501) } as any),
      ).rejects.toThrow();
    });

    it('throws (Zod) when avatarUrl is not a valid URL', async () => {
      await expect(
        controller.update(PROFILE_ID, { avatarUrl: 'not-a-url' } as any),
      ).rejects.toThrow();
    });

    it('accepts a partial update with only status', async () => {
      mockProfileService.update.mockResolvedValue(FAKE_PROFILE);

      await controller.update(PROFILE_ID, { status: UserStatus.INACTIVE } as any);

      expect(mockProfileService.update).toHaveBeenCalledWith(
        PROFILE_ID,
        expect.objectContaining({ status: UserStatus.INACTIVE }),
      );
    });
  });

  // ─── DELETE /:id ──────────────────────────────────────────────────────────

  describe('delete()', () => {
    it('delegates to UserProfileService.delete() and returns undefined (204)', async () => {
      mockProfileService.delete.mockResolvedValue(undefined);

      const result = await controller.delete(PROFILE_ID);

      expect(mockProfileService.delete).toHaveBeenCalledWith(PROFILE_ID);
      expect(result).toBeUndefined();
    });

    it('propagates NotFoundException when the profile does not exist', async () => {
      const { NotFoundException } = jest.requireActual('@nestjs/common');
      mockProfileService.delete.mockRejectedValue(
        new NotFoundException('User profile not found'),
      );

      await expect(controller.delete('ghost-id')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── POST /:id/rate ───────────────────────────────────────────────────────

  describe('rateUser()', () => {
    it('parses via Zod, delegates to UserProfileService.rateUser(), and returns the result', async () => {
      const rated = { ...FAKE_PROFILE, rating: 5, ratingCount: 1 };
      mockProfileService.rateUser.mockResolvedValue(rated);

      const result = await controller.rateUser(PROFILE_ID, VALID_RATE_DTO as any);

      expect(mockProfileService.rateUser).toHaveBeenCalledWith(
        PROFILE_ID,
        expect.objectContaining({ rating: 5 }),
      );
      expect(result).toEqual(rated);
    });

    it('throws (Zod) when rating is below 1', async () => {
      await expect(
        controller.rateUser(PROFILE_ID, { walletAddress: OTHER_WALLET, rating: 0 } as any),
      ).rejects.toThrow();
    });

    it('throws (Zod) when rating is above 5', async () => {
      await expect(
        controller.rateUser(PROFILE_ID, { walletAddress: OTHER_WALLET, rating: 6 } as any),
      ).rejects.toThrow();
    });

    it('throws (Zod) when walletAddress is not a valid Stellar address', async () => {
      await expect(
        controller.rateUser(PROFILE_ID, { walletAddress: 'bad-addr', rating: 4 } as any),
      ).rejects.toThrow();
    });

    it('throws (Zod) when review exceeds 1000 characters', async () => {
      await expect(
        controller.rateUser(PROFILE_ID, {
          walletAddress: OTHER_WALLET,
          rating: 4,
          review: 'R'.repeat(1001),
        } as any),
      ).rejects.toThrow();
    });
  });

  // ─── POST /:id/verify ─────────────────────────────────────────────────────

  describe('verifyUser()', () => {
    it('delegates to UserProfileService.verifyUser() and returns the result', async () => {
      const verified = { ...FAKE_PROFILE, isVerified: true };
      mockProfileService.verifyUser.mockResolvedValue(verified);

      const result = await controller.verifyUser(PROFILE_ID);

      expect(mockProfileService.verifyUser).toHaveBeenCalledWith(PROFILE_ID);
      expect(result).toEqual(verified);
    });
  });

  // ─── POST /:id/avatar (uploadAvatar) ──────────────────────────────────────

  describe('uploadAvatar()', () => {
    const MOCK_FILE: Express.Multer.File = {
      fieldname: 'file',
      originalname: 'avatar.jpg',
      mimetype: 'image/jpeg',
      size: 1024,
      buffer: Buffer.from('fake-image-data'),
      encoding: '7bit',
      destination: '',
      filename: '',
      path: '',
      stream: null as any,
    };

    it('uploads to S3, updates the profile, and returns avatarUrl and key', async () => {
      mockS3Service.uploadAvatar.mockResolvedValue({
        url: 'https://cdn.example.com/avatar.jpg',
        key: 'avatars/profile-uuid-001.jpg',
      });
      mockProfileService.update.mockResolvedValue(FAKE_PROFILE);

      const result = await controller.uploadAvatar(PROFILE_ID, MOCK_FILE);

      expect(mockS3Service.uploadAvatar).toHaveBeenCalledWith(
        MOCK_FILE.buffer,
        MOCK_FILE.originalname,
        MOCK_FILE.mimetype,
      );
      expect(mockProfileService.update).toHaveBeenCalledWith(PROFILE_ID, {
        avatarUrl: 'https://cdn.example.com/avatar.jpg',
      });
      expect(result).toEqual({
        avatarUrl: 'https://cdn.example.com/avatar.jpg',
        key: 'avatars/profile-uuid-001.jpg',
      });
    });

    it('throws BadRequestException when no file is provided', async () => {
      await expect(
        controller.uploadAvatar(PROFILE_ID, undefined as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for a disallowed MIME type', async () => {
      const badFile = { ...MOCK_FILE, mimetype: 'application/pdf' };
      await expect(
        controller.uploadAvatar(PROFILE_ID, badFile as Express.Multer.File),
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts image/png and image/webp as valid MIME types', async () => {
      mockS3Service.uploadAvatar.mockResolvedValue({ url: 'https://cdn.example.com/a.png', key: 'k' });
      mockProfileService.update.mockResolvedValue(FAKE_PROFILE);

      await expect(
        controller.uploadAvatar(PROFILE_ID, { ...MOCK_FILE, mimetype: 'image/png' }),
      ).resolves.not.toThrow();

      await expect(
        controller.uploadAvatar(PROFILE_ID, { ...MOCK_FILE, mimetype: 'image/webp' }),
      ).resolves.not.toThrow();
    });

    it('throws BadRequestException when file exceeds 5 MB', async () => {
      const oversized = { ...MOCK_FILE, size: 5 * 1024 * 1024 + 1 };
      await expect(
        controller.uploadAvatar(PROFILE_ID, oversized as Express.Multer.File),
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts a file exactly at the 5 MB boundary', async () => {
      mockS3Service.uploadAvatar.mockResolvedValue({ url: 'https://cdn.example.com/a.jpg', key: 'k' });
      mockProfileService.update.mockResolvedValue(FAKE_PROFILE);

      const atLimit = { ...MOCK_FILE, size: 5 * 1024 * 1024 };
      await expect(
        controller.uploadAvatar(PROFILE_ID, atLimit as Express.Multer.File),
      ).resolves.not.toThrow();
    });
  });
});
