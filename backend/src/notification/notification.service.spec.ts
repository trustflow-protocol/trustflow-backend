import { Test, TestingModule } from '@nestjs/testing';
import { NotificationService } from './notification.service';

describe('NotificationService', () => {
  let service: NotificationService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [NotificationService],
    }).compile();

    service = module.get<NotificationService>(NotificationService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getPreferences', () => {
    it('should return default preferences for unknown address', () => {
      const prefs = service.getPreferences('GUNKNOWN');
      expect(prefs).toEqual({
        emailEnabled: true,
        pushEnabled: true,
        disputeAlerts: true,
        evidenceReminders: true,
        milestoneNotifications: true,
      });
    });
  });

  describe('updatePreferences', () => {
    it('should update email preference', () => {
      const address = 'GTESTEMAIL';
      service.updatePreferences(address, { emailEnabled: false });
      const prefs = service.getPreferences(address);
      expect(prefs.emailEnabled).toBe(false);
      expect(prefs.pushEnabled).toBe(true);
    });

    it('should update multiple preferences at once', () => {
      const address = 'GTESTMULTI';
      service.updatePreferences(address, {
        emailEnabled: false,
        pushEnabled: false,
        disputeAlerts: false,
      });
      const prefs = service.getPreferences(address);
      expect(prefs.emailEnabled).toBe(false);
      expect(prefs.pushEnabled).toBe(false);
      expect(prefs.disputeAlerts).toBe(false);
      expect(prefs.evidenceReminders).toBe(true);
    });

    it('should not affect other addresses', () => {
      service.updatePreferences('GADDR1', { emailEnabled: false });
      const prefs2 = service.getPreferences('GADDR2');
      expect(prefs2.emailEnabled).toBe(true);
    });
  });

  describe('notifyDisputeEscalation', () => {
    it('should attempt to notify both parties', async () => {
      const result = await service.notifyDisputeEscalation({
        escrowId: 'esc-123',
        depositor: 'GDEPOSITOR',
        beneficiary: 'GBENEFICIARY',
        amountXLM: '100',
        reason: 'Test dispute',
        disputedAt: new Date().toISOString(),
      });
      expect(result).toHaveProperty('depositorNotified');
      expect(result).toHaveProperty('beneficiaryNotified');
    });
  });

  describe('notifyEvidenceRequired', () => {
    it('should return false when evidence reminders are disabled', async () => {
      const address = 'GEVIDENCEOFF';
      service.updatePreferences(address, { evidenceReminders: false });
      const result = await service.notifyEvidenceRequired(address, {
        escrowId: 'esc-123',
        depositor: 'GDEPOSITOR',
        beneficiary: 'GBENEFICIARY',
        amountXLM: '100',
      });
      expect(result).toBe(false);
    });

    it('should attempt notification when evidence reminders are enabled', async () => {
      const address = 'GEVIDENCEON';
      service.updatePreferences(address, { evidenceReminders: true });
      const result = await service.notifyEvidenceRequired(address, {
        escrowId: 'esc-123',
        depositor: 'GDEPOSITOR',
        beneficiary: 'GBENEFICIARY',
        amountXLM: '100',
        evidenceDeadline: new Date(Date.now() + 86400000).toISOString(),
      });
      // Without API keys configured, returns false but doesn't throw
      expect(typeof result).toBe('boolean');
    });
  });

  describe('notifyMilestoneEvent (#932)', () => {
    it('should short-circuit and return false when milestone notifications are disabled', async () => {
      const address = 'GMILESTONEOFF';
      service.updatePreferences(address, { milestoneNotifications: false });
      const spyBuild = jest.spyOn(service as any, 'buildMilestoneEmailBody');

      const result = await service.notifyMilestoneEvent(address, {
        gigId: 'gig-1',
        gigTitle: 'Test Gig',
        creator: 'GCREATOR',
        milestoneId: 'm-1',
        status: 'completed',
      });

      expect(result).toBe(false);
      expect(spyBuild).not.toHaveBeenCalled();
    });

    it('should short-circuit and return false when all channels are disabled', async () => {
      const address = 'GNOCHANNELS';
      service.updatePreferences(address, { emailEnabled: false, pushEnabled: false });
      const spyBuild = jest.spyOn(service as any, 'buildMilestoneEmailBody');

      const result = await service.notifyMilestoneEvent(address, {
        gigId: 'gig-2',
        gigTitle: 'Test Gig 2',
        creator: 'GCREATOR',
        milestoneId: 'm-2',
        status: 'completed',
      });

      expect(result).toBe(false);
      expect(spyBuild).not.toHaveBeenCalled();
    });
  });

  describe('email/push retry classification (#975)', () => {
    const originalResendKey = process.env.RESEND_API_KEY;
    const originalPushKey = process.env.PUSH_SERVER_KEY;

    beforeEach(() => {
      process.env.RESEND_API_KEY = 'test-resend-key';
      process.env.PUSH_SERVER_KEY = 'test-push-key';
    });

    afterEach(() => {
      if (originalResendKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = originalResendKey;
      if (originalPushKey === undefined) delete process.env.PUSH_SERVER_KEY;
      else process.env.PUSH_SERVER_KEY = originalPushKey;
    });

    it('retries a transient email timeout up to the max attempts before giving up', async () => {
      const svc = new NotificationService();
      const spy = jest
        .spyOn(svc as any, 'sendResendRequest')
        .mockRejectedValue(new Error('ETIMEDOUT: Resend API request timed out after 10000ms'));

      const result = await (svc as any).sendEmail('user@example.com', 'subject', '<p>body</p>');

      expect(result).toBe(false);
      expect(spy).toHaveBeenCalledTimes(3);
    });

    it('recovers an email send that times out once before a later attempt succeeds', async () => {
      const svc = new NotificationService();
      const spy = jest
        .spyOn(svc as any, 'sendResendRequest')
        .mockRejectedValueOnce(new Error('ETIMEDOUT: Resend API request timed out after 10000ms'))
        .mockResolvedValueOnce(undefined);

      const result = await (svc as any).sendEmail('user@example.com', 'subject', '<p>body</p>');

      expect(result).toBe(true);
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('does not retry a permanent (4xx) email failure', async () => {
      const svc = new NotificationService();
      const spy = jest
        .spyOn(svc as any, 'sendResendRequest')
        .mockRejectedValue(new Error('HTTP 401: Resend API returned: unauthorized'));

      const result = await (svc as any).sendEmail('user@example.com', 'subject', '<p>body</p>');

      expect(result).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('retries a 5xx email failure like a transient error', async () => {
      const svc = new NotificationService();
      const spy = jest
        .spyOn(svc as any, 'sendResendRequest')
        .mockRejectedValue(new Error('HTTP 503: Resend API returned: service unavailable'));

      const result = await (svc as any).sendEmail('user@example.com', 'subject', '<p>body</p>');

      expect(result).toBe(false);
      expect(spy).toHaveBeenCalledTimes(3);
    });

    it('retries a transient push notification failure up to its max attempts', async () => {
      const svc = new NotificationService();
      const spy = jest
        .spyOn(svc as any, 'sendPushRequest')
        .mockRejectedValue(new Error('ECONNRESET'));

      const result = await (svc as any).sendPushNotification('GADDR', 'title', 'body');

      expect(result).toBe(false);
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('does not retry a permanent push notification failure', async () => {
      const svc = new NotificationService();
      const spy = jest
        .spyOn(svc as any, 'sendPushRequest')
        .mockRejectedValue(new Error('HTTP 400: FCM API returned: invalid token'));

      const result = await (svc as any).sendPushNotification('GADDR', 'title', 'body');

      expect(result).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });
});
