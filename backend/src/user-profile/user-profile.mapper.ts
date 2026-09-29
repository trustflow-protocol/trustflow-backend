import type { UserProfile } from './user-profile.service';
import { OwnerProfileResponseDto, UserProfileResponseDto } from './user-profile.dto';

/**
 * Builds the public view of a profile from an explicit allow-list of fields, so a field
 * added to the stored `UserProfile` later (like `email`) stays private until someone
 * deliberately exposes it here.
 */
export function toPublicProfile(profile: UserProfile): UserProfileResponseDto {
  return {
    id: profile.id,
    walletAddress: profile.walletAddress,
    name: profile.name,
    bio: profile.bio,
    userType: profile.userType,
    avatarUrl: profile.avatarUrl,
    rating: profile.rating,
    ratingCount: profile.ratingCount,
    completedJobs: profile.completedJobs,
    status: profile.status,
    skills: profile.skills,
    socialLinks: profile.socialLinks,
    totalEarned: profile.totalEarned,
    totalSpent: profile.totalSpent,
    isVerified: profile.isVerified,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    lastActiveAt: profile.lastActiveAt,
  };
}

/** The public view plus the owner's own email address. */
export function toOwnerProfile(profile: UserProfile): OwnerProfileResponseDto {
  return { ...toPublicProfile(profile), email: profile.email };
}

/**
 * The owner view when `viewerAddress` is the profile's own wallet, the public view for
 * everyone else (including callers that are not authenticated).
 */
export function toProfileForViewer(
  profile: UserProfile,
  viewerAddress?: string,
): UserProfileResponseDto | OwnerProfileResponseDto {
  return viewerAddress !== undefined && viewerAddress === profile.walletAddress
    ? toOwnerProfile(profile)
    : toPublicProfile(profile);
}

/** Maps every profile of a paginated result to its public view. */
export function toPublicProfilePage(page: { data: UserProfile[]; total: number }): {
  data: UserProfileResponseDto[];
  total: number;
} {
  return { ...page, data: page.data.map(toPublicProfile) };
}
