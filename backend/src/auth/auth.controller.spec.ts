import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

describe('AuthController', () => {
  let controller: AuthController;
  let mockAuthService: any;

  const TEST_ADDRESS = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMNOP';
  const TEST_CHALLENGE = 'Sign this message to authenticate with TrustFlow: abc123';

  beforeEach(async () => {
    mockAuthService = {
      generateChallenge: jest.fn().mockResolvedValue(TEST_CHALLENGE),
      verifySignature: jest.fn().mockResolvedValue(true),
      generateToken: jest.fn().mockReturnValue('mock-jwt-token'),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: mockAuthService }],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getChallenge', () => {
    it('should return a challenge for a valid address', async () => {
      const result = await controller.getChallenge(TEST_ADDRESS);

      expect(result).toEqual({ challenge: TEST_CHALLENGE });
      expect(mockAuthService.generateChallenge).toHaveBeenCalledWith(TEST_ADDRESS);
    });

    it('should throw when address is missing', async () => {
      await expect(controller.getChallenge('')).rejects.toThrow('address required');
    });
  });

  describe('verify', () => {
    it('should return a token on valid signature', async () => {
      const result = await controller.verify({
        address: TEST_ADDRESS,
        signature: 'SGVsbG8gV29ybGQh',
      });

      expect(result).toEqual({ token: 'mock-jwt-token' });
      expect(mockAuthService.verifySignature).toHaveBeenCalledWith(
        TEST_ADDRESS,
        'SGVsbG8gV29ybGQh',
      );
      expect(mockAuthService.generateToken).toHaveBeenCalledWith(TEST_ADDRESS);
    });

    it('should throw on invalid signature', async () => {
      mockAuthService.verifySignature.mockResolvedValue(false);

      await expect(
        controller.verify({
          address: TEST_ADDRESS,
          signature: 'invalid',
        }),
      ).rejects.toThrow('Invalid signature');
    });
  });
});
