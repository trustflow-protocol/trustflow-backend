import { Controller, Post, Delete, Body, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiParam } from '@nestjs/swagger';
import { WebhookService } from './webhook.service';

@ApiTags('Webhooks')
@Controller('webhooks')
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  @Post()
  @ApiOperation({
    summary: 'Register webhook',
    description:
      'Register a webhook endpoint to receive event notifications. Supported events: escrow.created, escrow.released, dispute.raised, dispute.resolved.',
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
  @ApiResponse({ status: 400, description: 'Invalid webhook URL or ID' })
  register(@Body() body: { id: string; url: string }) {
    this.webhookService.register(body.id, body.url);
    return { registered: true, id: body.id };
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
