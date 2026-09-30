import { Test, TestingModule } from '@nestjs/testing';
import { WebhookProcessor } from './webhook.processor';
import { OutboxService } from '../outbox/outbox.service';
import { WebhookService } from './webhook.service';
import { MetricsService } from '../monitoring/metrics.service';
import { OutboxEvent } from '../outbox/outbox.types';

describe('WebhookProcessor', () => {
  let processor: WebhookProcessor;
  let outboxService: jest.Mocked<OutboxService>;
  let webhookService: jest.Mocked<WebhookService>;
  let metricsService: jest.Mocked<MetricsService>;

  beforeEach(async () => {
    const mockOutboxService = {
      reclaimExpired: jest.fn(),
      claimDue: jest.fn(),
      markDelivered: jest.fn(),
      retry: jest.fn(),
    };

    const mockWebhookService = {
      deliver: jest.fn(),
    };

    const mockMetricsService = {
      increment: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookProcessor,
        { provide: OutboxService, useValue: mockOutboxService },
        { provide: WebhookService, useValue: mockWebhookService },
        { provide: MetricsService, useValue: mockMetricsService },
      ],
    }).compile();

    processor = module.get<WebhookProcessor>(WebhookProcessor);
    outboxService = module.get(OutboxService);
    webhookService = module.get(WebhookService);
    metricsService = module.get(MetricsService);
  });

  it('should be defined', () => {
    expect(processor).toBeDefined();
  });

  describe('processWebhooks', () => {
    it('should mark webhook as delivered on successful HTTP 2xx response', async () => {
      const mockEvent: OutboxEvent = {
        id: 'evt-123',
        dedupKey: 'webhook:test-event',
        type: 'test.event',
        aggregateType: 'webhook',
        aggregateId: 'dispatch',
        payload: { data: 'test' },
        status: 'processing',
        attempts: 0,
        nextAttemptAt: Date.now(),
        createdAt: new Date().toISOString(),
      };

      outboxService.reclaimExpired.mockResolvedValue();
      outboxService.claimDue.mockResolvedValue([mockEvent]);
      webhookService.deliver.mockResolvedValue();
      outboxService.markDelivered.mockResolvedValue();

      await processor.processWebhooks();

      expect(webhookService.deliver).toHaveBeenCalledWith(
        mockEvent.type,
        mockEvent.payload,
        mockEvent.dedupKey,
      );
      expect(outboxService.markDelivered).toHaveBeenCalledWith(mockEvent, true);
      expect(outboxService.retry).not.toHaveBeenCalled();
      expect(metricsService.increment).toHaveBeenCalledWith('webhook_delivery_total', {
        result: 'delivered',
        type: mockEvent.type,
      });
    });

    it('should retry webhook on HTTP 500 response instead of marking as delivered', async () => {
      const mockEvent: OutboxEvent = {
        id: 'evt-456',
        dedupKey: 'webhook:test-event-500',
        type: 'test.event.fail',
        aggregateType: 'webhook',
        aggregateId: 'dispatch',
        payload: { data: 'fail' },
        status: 'processing',
        attempts: 1,
        nextAttemptAt: Date.now(),
        createdAt: new Date().toISOString(),
      };

      const http500Error = new Error('500');

      outboxService.reclaimExpired.mockResolvedValue();
      outboxService.claimDue.mockResolvedValue([mockEvent]);
      webhookService.deliver.mockRejectedValue(http500Error);
      outboxService.retry.mockResolvedValue();

      await processor.processWebhooks();

      expect(webhookService.deliver).toHaveBeenCalledWith(
        mockEvent.type,
        mockEvent.payload,
        mockEvent.dedupKey,
      );
      expect(outboxService.retry).toHaveBeenCalledWith(mockEvent, http500Error, true);
      expect(outboxService.markDelivered).not.toHaveBeenCalled();
      expect(metricsService.increment).toHaveBeenCalledWith('webhook_delivery_total', {
        result: 'retry',
        type: mockEvent.type,
      });
    });

    it('should retry webhook on network drop (ECONNREFUSED) instead of marking as delivered', async () => {
      const mockEvent: OutboxEvent = {
        id: 'evt-789',
        dedupKey: 'webhook:test-event-network',
        type: 'test.event.network',
        aggregateType: 'webhook',
        aggregateId: 'dispatch',
        payload: { data: 'network-fail' },
        status: 'processing',
        attempts: 0,
        nextAttemptAt: Date.now(),
        createdAt: new Date().toISOString(),
      };

      const networkError = new Error('ECONNREFUSED');

      outboxService.reclaimExpired.mockResolvedValue();
      outboxService.claimDue.mockResolvedValue([mockEvent]);
      webhookService.deliver.mockRejectedValue(networkError);
      outboxService.retry.mockResolvedValue();

      await processor.processWebhooks();

      expect(webhookService.deliver).toHaveBeenCalledWith(
        mockEvent.type,
        mockEvent.payload,
        mockEvent.dedupKey,
      );
      expect(outboxService.retry).toHaveBeenCalledWith(mockEvent, networkError, true);
      expect(outboxService.markDelivered).not.toHaveBeenCalled();
      expect(metricsService.increment).toHaveBeenCalledWith('webhook_delivery_total', {
        result: 'retry',
        type: mockEvent.type,
      });
    });

    it('should process multiple webhooks in a batch', async () => {
      const mockEvents: OutboxEvent[] = [
        {
          id: 'evt-001',
          dedupKey: 'webhook:batch-1',
          type: 'test.batch.1',
          aggregateType: 'webhook',
          aggregateId: 'dispatch',
          payload: { data: 'batch-1' },
          status: 'processing',
          attempts: 0,
          nextAttemptAt: Date.now(),
          createdAt: new Date().toISOString(),
        },
        {
          id: 'evt-002',
          dedupKey: 'webhook:batch-2',
          type: 'test.batch.2',
          aggregateType: 'webhook',
          aggregateId: 'dispatch',
          payload: { data: 'batch-2' },
          status: 'processing',
          attempts: 0,
          nextAttemptAt: Date.now(),
          createdAt: new Date().toISOString(),
        },
      ];

      outboxService.reclaimExpired.mockResolvedValue();
      outboxService.claimDue.mockResolvedValue(mockEvents);
      webhookService.deliver.mockResolvedValue();
      outboxService.markDelivered.mockResolvedValue();

      await processor.processWebhooks();

      expect(webhookService.deliver).toHaveBeenCalledTimes(2);
      expect(outboxService.markDelivered).toHaveBeenCalledTimes(2);
      expect(metricsService.increment).toHaveBeenCalledTimes(2);
    });

    it('should continue processing remaining webhooks if one fails', async () => {
      const successEvent: OutboxEvent = {
        id: 'evt-success',
        dedupKey: 'webhook:success',
        type: 'test.success',
        aggregateType: 'webhook',
        aggregateId: 'dispatch',
        payload: { data: 'success' },
        status: 'processing',
        attempts: 0,
        nextAttemptAt: Date.now(),
        createdAt: new Date().toISOString(),
      };

      const failEvent: OutboxEvent = {
        id: 'evt-fail',
        dedupKey: 'webhook:fail',
        type: 'test.fail',
        aggregateType: 'webhook',
        aggregateId: 'dispatch',
        payload: { data: 'fail' },
        status: 'processing',
        attempts: 1,
        nextAttemptAt: Date.now(),
        createdAt: new Date().toISOString(),
      };

      outboxService.reclaimExpired.mockResolvedValue();
      outboxService.claimDue.mockResolvedValue([failEvent, successEvent]);
      webhookService.deliver
        .mockRejectedValueOnce(new Error('503'))
        .mockResolvedValueOnce(undefined);
      outboxService.retry.mockResolvedValue();
      outboxService.markDelivered.mockResolvedValue();

      await processor.processWebhooks();

      expect(webhookService.deliver).toHaveBeenCalledTimes(2);
      expect(outboxService.retry).toHaveBeenCalledWith(failEvent, expect.any(Error), true);
      expect(outboxService.markDelivered).toHaveBeenCalledWith(successEvent, true);
    });
  });
});
