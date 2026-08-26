import { z } from 'zod';

const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

export const UploadDeliverableSchema = z.object({
  gigId: z.string().min(1),
  freelancer: z.string().regex(STELLAR_ADDRESS_REGEX, 'Invalid Stellar address'),
  content: z.string().min(1, 'Base64-encoded content is required'),
  filename: z.string().min(1).max(255),
});

export type UploadDeliverableDto = z.infer<typeof UploadDeliverableSchema>;
