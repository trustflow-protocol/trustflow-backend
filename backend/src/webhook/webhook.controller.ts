import { Controller, Post, Delete, Body, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiParam } from '@nestjs/swagger';
import { WebhookService } from './webhook.service';
import { RegisterWebhookDto, RegisterWebhookSchema } from './webhook.dto';

@ApiTags('Webhooks')
@Controller('webhooks')
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  @Post()
  @ApiOperation({
    summary: 'Register webhook',
    description:
      'Register a webhook endpoint to receive event notifications.\n\n' +
      'Supported events:\n' +
      '- **Gig Events (Outbox)**: gig.created, gig.accepted, gig.expired, gig.cancelled\n' +
      '- **Dispute Events (Direct)**: dispute.raised\n' +
      '- **Dispute Saga Events (Outbox)**: dispute.escalated, dispute.jurors_assigned, dispute.vote_cast, dispute.verdict_reached, dispute.payout_executed, dispute.saga_completed, dispute.saga_compensating, dispute.saga_failed\n' +
      '- **IPFS Events (Outbox)**: ipfs.pin.created, ipfs.pin.degraded, ipfs.pin.restored, ipfs.pin.lost, ipfs.pin.failed, ipfs.pin.removed\n' +
      '- **Reconciliation Events (Outbox)**: escrow_reconciliation.drift_detected, escrow_reconciliation.escrow_backfilled\n\n' +
      'Pass events: ["*"] to subscribe to all events, or specify individual event types.',
  })
  @ApiBody({
    description: 'Webhook registration details',
    schema: {
      type: 'object',
      required: ['id', 'url'],
      properties: {
        id: {
          type: 'string',
          description: 'Unique identifier for this webhook',
          example: 'my-webhook-1',
        },
        url: {
          type: 'string',
          format: 'uri',
          description: 'HTTPS endpoint to receive webhook POST requests',
          example: 'https://example.com/webhooks/trustflow',
        },
        events: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of events to subscribe to (defaults to ["*"] for all events)',
          example: ['gig.created', 'dispute.raised', 'dispute.escalated'],
        },
        secret: {
          type: 'string',
          minLength: 16,
          description:
            'Optional HMAC secret (min 16 characters) used to sign outgoing webhook payloads via the X-TrustFlow-Signature header',
          example: 'your-16-plus-character-secret',
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Webhook registered successfully',
    schema: {
      type: 'object',
      properties: {
        registered: { type: 'boolean', example: true },
        id: { type: 'string', example: 'my-webhook-1' },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Invalid webhook URL, ID, or secret' })
  async register(@Body() body: RegisterWebhookDto) {
    const validated = RegisterWebhookSchema.parse(body);
    await this.webhookService.register(validated.id, validated.url, validated.secret);
    return { registered: true, id: validated.id };
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Unregister webhook',
    description: 'Remove a previously registered webhook by its ID.',
  })
  @ApiParam({
    name: 'id',
    description: 'Webhook ID',
    example: 'my-webhook-1',
  })
  @ApiResponse({
    status: 200,
    description: 'Webhook unregistered successfully',
    schema: {
      type: 'object',
      properties: {
        unregistered: { type: 'boolean', example: true },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Webhook not found' })
  unregister(@Param('id') id: string) {
    this.webhookService.unregister(id);
    return { unregistered: true };
  }
}
