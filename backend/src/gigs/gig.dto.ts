import { z } from 'zod';
import { GigStatus } from './gig.entity';

const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;
const XLM_AMOUNT_REGEX = /^(?:0|[1-9]\d*)(?:\.\d{1,7})?$/;

const SkillsSchema = z
  .array(z.string().trim().min(1, 'Skill cannot be empty').max(50, 'Skill is too long'))
  .max(20, 'Maximum 20 skills allowed')
  .default([]);

export const CreateGigSchema = z.object({
  clientAddress: z.string().regex(STELLAR_ADDRESS_REGEX, 'Invalid Stellar wallet address'),
  title: z.string().trim().min(5, 'Title must be at least 5 characters').max(120),
  description: z.string().trim().min(20, 'Description must be at least 20 characters').max(5000),
  budgetXLM: z.string().regex(XLM_AMOUNT_REGEX, 'Invalid XLM amount'),
  category: z.string().trim().min(2).max(80).optional(),
  skills: SkillsSchema,
  deadline: z.string().datetime({ offset: true }).optional(),
});

export type CreateGigDto = z.infer<typeof CreateGigSchema>;

export const UpdateGigSchema = z.object({
  title: z.string().trim().min(5).max(120).optional(),
  description: z.string().trim().min(20).max(5000).optional(),
  budgetXLM: z.string().regex(XLM_AMOUNT_REGEX, 'Invalid XLM amount').optional(),
  category: z.string().trim().min(2).max(80).optional(),
  skills: SkillsSchema.optional(),
  status: z.nativeEnum(GigStatus).optional(),
  deadline: z.string().datetime({ offset: true }).optional(),
});

export type UpdateGigDto = z.infer<typeof UpdateGigSchema>;

export interface GigFilters {
  clientAddress?: string;
  status?: GigStatus;
  category?: string;
  skill?: string;
}

export const GigFiltersSchema = z.object({
  clientAddress: z
    .string()
    .regex(STELLAR_ADDRESS_REGEX, 'Invalid Stellar wallet address')
    .optional(),
  status: z.nativeEnum(GigStatus).optional(),
  category: z.string().trim().min(2).max(80).optional(),
  skill: z.string().trim().min(1).max(50).optional(),
});
