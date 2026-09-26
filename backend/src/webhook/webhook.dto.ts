import { z } from 'zod';

export const RegisterWebhookSchema = z.object({
  id: z.string().min(1).max(64),
  url: z
    .string()
    .url('Must be a valid URL')
    .refine(
      url => {
        try {
          const parsed = new URL(url);
          return parsed.protocol === 'http:' || parsed.protocol === 'https:';
        } catch {
          return false;
        }
      },
      { message: 'Webhook URL must use http or https' },
    ),
  events: z.array(z.string()).optional().default(['*']),
  secret: z.string().min(16).optional(),
});

export type RegisterWebhookDto = z.input<typeof RegisterWebhookSchema>;

export enum WebhookEvent {
  EscrowCreated = 'escrow.created',
  EscrowFunded = 'escrow.funded',
  EscrowReleased = 'escrow.released',
  EscrowCancelled = 'escrow.cancelled',
  EscrowSplit = 'escrow.split',
  EscrowDisputed = 'escrow.disputed',
}
