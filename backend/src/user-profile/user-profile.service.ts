import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { UserProfileEntity, UserType, UserStatus } from './user-profile.entity';
import { CreateUserProfileDto, UpdateUserProfileDto, RateUserDto } from './user-profile.dto';
import { randomUUID } from 'crypto';

export interface UserProfile {
  id: string;
  walletAddress: string;
  name: string;
  bio?: string;
  userType: UserType;
  avatarUrl?: string;
  email?: string;
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

@Injectable()
export class UserProfileService {
  private profiles: Map<string, UserProfile> = new Map();
  private walletAddressIndex: Map<string, string> = new Map(); // walletAddress -> profileId

  /**
   * Create a new user profile
   */
  async create(dto: CreateUserProfileDto): Promise<UserProfile> {
    // Check if wallet address already exists
    if (this.walletAddressIndex.has(dto.walletAddress)) {
      throw new ConflictException('Profile with this wallet address already exists');
    }

    const id = randomUUID();
    const now = new Date().toISOString();

    const profile: UserProfile = {
      id,
      walletAddress: dto.walletAddress,
      name: dto.name,
      bio: dto.bio,
      userType: dto.userType,
      avatarUrl: dto.avatarUrl,
      email: dto.email,
      rating: 0,
      ratingCount: 0,
      completedJobs: 0,
      status: UserStatus.ACTIVE,
      skills: dto.skills,
      socialLinks: dto.socialLinks,
      totalEarned: '0',
      totalSpent: '0',
      isVerified: false,
      createdAt: now,
      updatedAt: now,
      lastActiveAt: now,
    };

    this.profiles.set(id, profile);
    this.walletAddressIndex.set(dto.walletAddress, id);

    return profile;
  }

  /**
   * Find profile by ID
   */
  async findById(id: string): Promise<UserProfile> {
    const profile = this.profiles.get(id);
    if (!profile) {
      throw new NotFoundException('User profile not found');
    }
    return profile;
  }

  /**
   * Find profile by wallet address
   */
  async findByWalletAddress(walletAddress: string): Promise<UserProfile> {
    const profileId = this.walletAddressIndex.get(walletAddress);
    if (!profileId) {
      throw new NotFoundException('User profile not found');
    }
    return this.findById(profileId);
  }

  /**
   * Get all profiles with optional filters
   */
  async findAll(filters?: {
    userType?: UserType;
    status?: UserStatus;
    minRating?: number;
  }): Promise<UserProfile[]> {
    let profiles = Array.from(this.profiles.values());

    if (filters?.userType) {
      profiles = profiles.filter(
        p => p.userType === filters.userType || p.userType === UserType.BOTH,
      );
    }

    if (filters?.status) {
      profiles = profiles.filter(p => p.status === filters.status);
    }

    if (filters?.minRating !== undefined) {
      profiles = profiles.filter(p => p.rating >= (filters.minRating ?? 0));
    }

    return profiles;
  }

  /**
   * Update a user profile
   */
  async update(id: string, dto: UpdateUserProfileDto): Promise<UserProfile> {
    const profile = await this.findById(id);

    // Update fields
    if (dto.name !== undefined) profile.name = dto.name;
    if (dto.bio !== undefined) profile.bio = dto.bio;
    if (dto.userType !== undefined) profile.userType = dto.userType;
    if (dto.avatarUrl !== undefined) profile.avatarUrl = dto.avatarUrl;
    if (dto.email !== undefined) profile.email = dto.email;
    if (dto.skills !== undefined) profile.skills = dto.skills;
    if (dto.socialLinks !== undefined) {
      profile.socialLinks = { ...profile.socialLinks, ...dto.socialLinks };
    }
    if (dto.status !== undefined) profile.status = dto.status;

    profile.updatedAt = new Date().toISOString();

    return profile;
  }

  /**
   * Delete a user profile
   */
  async delete(id: string): Promise<void> {
    const profile = await this.findById(id);
    this.walletAddressIndex.delete(profile.walletAddress);
    this.profiles.delete(id);
  }

  /**
   * Rate a user profile
   * Updates the overall rating using a weighted average
   */
  async rateUser(id: string, dto: RateUserDto): Promise<UserProfile> {
    const profile = await this.findById(id);

    // Calculate new rating using weighted average
    const totalRating = profile.rating * profile.ratingCount;
    const newRatingCount = profile.ratingCount + 1;
    const newRating = (totalRating + dto.rating) / newRatingCount;

    profile.rating = Math.round(newRating * 100) / 100; // Round to 2 decimal places
    profile.ratingCount = newRatingCount;
    profile.updatedAt = new Date().toISOString();

    return profile;
  }

  /**
   * Increment completed jobs counter
   */
  async incrementCompletedJobs(id: string): Promise<UserProfile> {
    const profile = await this.findById(id);
    profile.completedJobs += 1;
    profile.updatedAt = new Date().toISOString();
    return profile;
  }

  /**
   * Update total earned (for freelancers)
   */
  async updateTotalEarned(id: string, amount: string): Promise<UserProfile> {
    const profile = await this.findById(id);
    const currentEarned = parseFloat(profile.totalEarned || '0');
    const additionalAmount = parseFloat(amount);
    profile.totalEarned = (currentEarned + additionalAmount).toFixed(7);
    profile.updatedAt = new Date().toISOString();
    return profile;
  }

  /**
   * Update total spent (for clients)
   */
  async updateTotalSpent(id: string, amount: string): Promise<UserProfile> {
    const profile = await this.findById(id);
    const currentSpent = parseFloat(profile.totalSpent || '0');
    const additionalAmount = parseFloat(amount);
    profile.totalSpent = (currentSpent + additionalAmount).toFixed(7);
    profile.updatedAt = new Date().toISOString();
    return profile;
  }

  /**
   * Verify a user profile
   */
  async verifyUser(id: string): Promise<UserProfile> {
    const profile = await this.findById(id);
    profile.isVerified = true;
    profile.updatedAt = new Date().toISOString();
    return profile;
  }

  /**
   * Update last active timestamp
   */
  async updateLastActive(id: string): Promise<void> {
    const profile = await this.findById(id);
    profile.lastActiveAt = new Date().toISOString();
  }

  /**
   * Search profiles by name or skills
   */
  async search(query: string): Promise<UserProfile[]> {
    const lowerQuery = query.toLowerCase();
    return Array.from(this.profiles.values()).filter(
      profile =>
        profile.name.toLowerCase().includes(lowerQuery) ||
        profile.bio?.toLowerCase().includes(lowerQuery) ||
        profile.skills?.some(skill => skill.toLowerCase().includes(lowerQuery)),
    );
  }
}
