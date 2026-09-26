import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

/**
 * Swagger schemas for profile responses, mirroring `UserProfileResponseDto` and
 * `OwnerProfileResponseDto`. Public routes use the schema WITHOUT `email`; only responses
 * meant for the profile's owner document it.
 */
const publicProfileProperties: Record<string, SchemaObject> = {
  id: { type: 'string', format: 'uuid' },
  walletAddress: { type: 'string' },
  name: { type: 'string' },
  bio: { type: 'string', nullable: true },
  userType: { type: 'string', enum: ['freelancer', 'client', 'both'] },
  avatarUrl: { type: 'string', nullable: true },
  rating: { type: 'number', example: 0 },
  ratingCount: { type: 'number', example: 0 },
  completedJobs: { type: 'number', example: 0 },
  status: { type: 'string', enum: ['active', 'inactive', 'suspended'] },
  skills: { type: 'array', items: { type: 'string' }, nullable: true },
  socialLinks: { type: 'object', nullable: true },
  totalEarned: { type: 'string', example: '0' },
  totalSpent: { type: 'string', example: '0' },
  isVerified: { type: 'boolean', example: false },
  createdAt: { type: 'string', format: 'date-time' },
  updatedAt: { type: 'string', format: 'date-time' },
  lastActiveAt: { type: 'string', format: 'date-time', nullable: true },
};

/** Profile as anyone may see it: no email address. */
export const PUBLIC_PROFILE_SCHEMA: SchemaObject = {
  type: 'object',
  properties: publicProfileProperties,
};

/** Profile as its owner sees it: the public fields plus their own email address. */
export const OWNER_PROFILE_SCHEMA: SchemaObject = {
  type: 'object',
  properties: {
    ...publicProfileProperties,
    email: { type: 'string', nullable: true },
  },
};
