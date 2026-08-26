import { z } from 'zod';

const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

export const CreateGigSchema = z.object({
  creator: z.string().regex(STELLAR_ADDRESS_REGEX, 'Invalid Stellar address'),
  title: z.string().min(1, 'Title is required').max(200, 'Title must not exceed 200 characters'),
  budgetXLM: z.string().regex(/^\d+(\.\d{1,7})?$/, 'Invalid XLM amount'),
  /** Hours to wait for a response before the sweep marks the gig expired. Defaults to 72. */
  responseWindowHours: z
    .number()
    .int()
    .positive()
    .max(24 * 30, 'Response window cannot exceed 30 days')
    .optional(),
});

export type CreateGigDto = z.infer<typeof CreateGigSchema>;

export const AcceptGigSchema = z.object({
  responder: z.string().regex(STELLAR_ADDRESS_REGEX, 'Invalid Stellar address'),
});

export type AcceptGigDto = z.infer<typeof AcceptGigSchema>;

export const UpdateGigSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  budgetXLM: z.string().regex(/^\d+(\.\d{1,7})?$/, 'Invalid XLM amount').optional(),
  responseWindowHours: z.number().int().positive().max(24 * 30).optional(),
});

export type UpdateGigDto = z.infer<typeof UpdateGigSchema>;
