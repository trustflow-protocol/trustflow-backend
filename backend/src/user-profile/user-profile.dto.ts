import { z } from 'zod';
import { UserType, UserStatus } from './user-profile.entity';

/**
 * Stellar address validation regex
 * G-prefixed, 56 characters total
 */
const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

/**
 * Email validation regex
 */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * URL validation regex
 */
const URL_REGEX = /^https?:\/\/.+/;

/**
 * Schema for creating a new user profile
 */
export const CreateUserProfileSchema = z.object({
  walletAddress: z
    .string()
    .regex(STELLAR_ADDRESS_REGEX, 'Invalid Stellar wallet address'),
  name: z
    .string()
    .min(2, 'Name must be at least 2 characters')
    .max(100, 'Name must not exceed 100 characters'),
  bio: z
    .string()
    .max(500, 'Bio must not exceed 500 characters')
    .optional(),
  userType: z.nativeEnum(UserType),
  avatarUrl: z
    .string()
    .regex(URL_REGEX, 'Invalid avatar URL')
    .optional(),
  email: z
    .string()
    .regex(EMAIL_REGEX, 'Invalid email address')
    .optional(),
  skills: z
    .array(z.string().max(50))
    .max(20, 'Maximum 20 skills allowed')
    .optional(),
  socialLinks: z
    .object({
      twitter: z.string().regex(URL_REGEX).optional(),
      github: z.string().regex(URL_REGEX).optional(),
      linkedin: z.string().regex(URL_REGEX).optional(),
      website: z.string().regex(URL_REGEX).optional(),
    })
    .optional(),
});

export type CreateUserProfileDto = z.infer<typeof CreateUserProfileSchema>;

/**
 * Schema for updating an existing user profile
 * All fields are optional except walletAddress for identification
 */
export const UpdateUserProfileSchema = z.object({
  name: z
    .string()
    .min(2, 'Name must be at least 2 characters')
    .max(100, 'Name must not exceed 100 characters')
    .optional(),
  bio: z
    .string()
    .max(500, 'Bio must not exceed 500 characters')
    .optional(),
  userType: z.nativeEnum(UserType).optional(),
  avatarUrl: z
    .string()
    .regex(URL_REGEX, 'Invalid avatar URL')
    .optional(),
  email: z
    .string()
    .regex(EMAIL_REGEX, 'Invalid email address')
    .optional(),
  skills: z
    .array(z.string().max(50))
    .max(20, 'Maximum 20 skills allowed')
    .optional(),
  socialLinks: z
    .object({
      twitter: z.string().regex(URL_REGEX).optional(),
      github: z.string().regex(URL_REGEX).optional(),
      linkedin: z.string().regex(URL_REGEX).optional(),
      website: z.string().regex(URL_REGEX).optional(),
    })
    .optional(),
  status: z.nativeEnum(UserStatus).optional(),
});

export type UpdateUserProfileDto = z.infer<typeof UpdateUserProfileSchema>;

/**
 * Schema for rating a user
 */
export const RateUserSchema = z.object({
  walletAddress: z
    .string()
    .regex(STELLAR_ADDRESS_REGEX, 'Invalid Stellar wallet address'),
  rating: z
    .number()
    .min(1, 'Rating must be at least 1')
    .max(5, 'Rating must not exceed 5'),
  review: z
    .string()
    .max(1000, 'Review must not exceed 1000 characters')
    .optional(),
});

export type RateUserDto = z.infer<typeof RateUserSchema>;

/**
 * Response DTO for user profile
 * Excludes sensitive internal fields
 */
export interface UserProfileResponseDto {
  id: string;
  walletAddress: string;
  name: string;
  bio?: string;
  userType: UserType;
  avatarUrl?: string;
  rating: number;
  ratingCount: number;
  completedJobs: number;
  status: UserStatus;
  skills?: string[];
  socialLinks?: {
    twitter?: string;
    github?: string;
    linkedin?: string;
    website?: string;
  };
  totalEarned?: string;
  totalSpent?: string;
  isVerified: boolean;
  createdAt: string;
  updatedAt: string;
  lastActiveAt?: string;
}
