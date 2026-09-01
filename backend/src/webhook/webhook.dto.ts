import { z } from 'zod';

export const RegisterWebhookSchema = z.object({
  id: z.string().min(1).max(64),
  url: z.string().url('Must be a valid URL'),
  events: z.array(z.string()).optional().default(['*']),
  secret: z.string().min(16).optional(),
});

export type RegisterWebhookDto = z.input<typeof RegisterWebhookSchema>;

export enum WebhookEvent {
  EscrowCreated = 'escrow.created',
  EscrowReleased = 'escrow.released',
  DisputeRaised = 'dispute.raised',
  DisputeResolved = 'dispute.resolved',
}
