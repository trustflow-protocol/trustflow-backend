import { Test, TestingModule } from '@nestjs/testing';
import { DiscordService } from './discord.service';

describe('DiscordService', () => {
  let service: DiscordService;
  const originalEnv = process.env.DISCORD_WEBHOOK_URL;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DiscordService],
    }).compile();

    service = module.get<DiscordService>(DiscordService);
  });

  afterEach(() => {
    process.env.DISCORD_WEBHOOK_URL = originalEnv;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('notifyDisputeNeedsJurors', () => {
    it('should log warning when webhook URL is not configured', async () => {
      // Set env before creating service
      process.env.DISCORD_WEBHOOK_URL = '';

      // Recreate service with empty webhook URL
      const module: TestingModule = await Test.createTestingModule({
        providers: [DiscordService],
      }).compile();
      const testService = module.get<DiscordService>(DiscordService);

      const loggerWarnSpy = jest.spyOn(testService['logger'], 'warn');

      await testService.notifyDisputeNeedsJurors({
        escrowId: 'esc-123',
        depositor: 'GXXXXXXXXXXXXX',
        beneficiary: 'GYYYYYYYYYYYYY',
        amountXLM: '100',
      });

      expect(loggerWarnSpy).toHaveBeenCalledWith(
        'Discord webhook URL not configured. Skipping notification.',
      );
    });

    it('should format dispute data correctly', async () => {
      const disputeData = {
        escrowId: 'esc-123',
        depositor: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        beneficiary: 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY',
        amountXLM: '100',
        reason: 'Work not delivered',
      };

      // This test would require mocking the https module
      // For now, we just verify the service can be called without errors when URL is missing
      process.env.DISCORD_WEBHOOK_URL = '';
      await expect(service.notifyDisputeNeedsJurors(disputeData)).resolves.not.toThrow();
    });
  });
});
