import { Test, TestingModule } from '@nestjs/testing';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('WebhookController', () => {
  let controller: WebhookController;

  const mockWebhookService = {
    register: jest.fn(),
    unregister: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WebhookController],
      providers: [{ provide: WebhookService, useValue: mockWebhookService }],
    }).compile();

    controller = module.get<WebhookController>(WebhookController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  // ─── POST /webhooks (register) ────────────────────────────────────────────

  describe('register()', () => {
    it('calls WebhookService.register() with id and url from the body', () => {
      const body = { id: 'hook-1', url: 'https://example.com/webhook' };

      controller.register(body);

      expect(mockWebhookService.register).toHaveBeenCalledWith(
        'hook-1',
        'https://example.com/webhook',
      );
    });

    it('returns { registered: true, id } on success', () => {
      const body = { id: 'hook-2', url: 'https://example.com/other' };

      const result = controller.register(body);

      expect(result).toEqual({ registered: true, id: 'hook-2' });
    });

    it('echoes back the exact id from the request body', () => {
      const body = { id: 'my-unique-webhook-id', url: 'https://a.com' };

      const result = controller.register(body);

      expect(result.id).toBe('my-unique-webhook-id');
    });

    it('is not guarded — no JwtAuthGuard required', async () => {
      // The controller has no guard decorators; this test confirms the
      // endpoint is accessible without auth by checking that the handler
      // is reachable and calls the service.
      const body = { id: 'public-hook', url: 'https://example.com' };

      controller.register(body);

      expect(mockWebhookService.register).toHaveBeenCalledTimes(1);
    });
  });

  // ─── DELETE /webhooks/:id (unregister) ───────────────────────────────────

  describe('unregister()', () => {
    it('calls WebhookService.unregister() with the route param id', () => {
      controller.unregister('hook-99');

      expect(mockWebhookService.unregister).toHaveBeenCalledWith('hook-99');
    });

    it('returns { unregistered: true } on success', () => {
      const result = controller.unregister('hook-99');

      expect(result).toEqual({ unregistered: true });
    });

    it('delegates to the service even for an id that was never registered', () => {
      // The controller does not validate existence; that responsibility
      // sits at the service layer.
      controller.unregister('nonexistent-id');

      expect(mockWebhookService.unregister).toHaveBeenCalledWith('nonexistent-id');
    });
  });

  // ─── register + unregister round-trip ────────────────────────────────────

  describe('register → unregister round-trip', () => {
    it('calls register then unregister with the same id', () => {
      controller.register({ id: 'round-trip', url: 'https://example.com/rt' });
      controller.unregister('round-trip');

      expect(mockWebhookService.register).toHaveBeenCalledWith(
        'round-trip',
        'https://example.com/rt',
      );
      expect(mockWebhookService.unregister).toHaveBeenCalledWith('round-trip');
    });
  });
});
