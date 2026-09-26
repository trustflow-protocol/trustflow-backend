import { UserStatus, UserType } from './user-profile.entity';
import type { UserProfile } from './user-profile.service';
import {
  toOwnerProfile,
  toProfileForViewer,
  toPublicProfile,
  toPublicProfilePage,
} from './user-profile.mapper';

const WALLET = 'G' + 'A'.repeat(55);
const OTHER_WALLET = 'G' + 'B'.repeat(55);
const EMAIL = 'private@example.com';

const PROFILE: UserProfile = {
  id: 'profile-1',
  walletAddress: WALLET,
  name: 'Alice',
  bio: 'Solidity developer',
  userType: UserType.FREELANCER,
  avatarUrl: 'https://example.com/a.png',
  email: EMAIL,
  rating: 4.5,
  ratingCount: 2,
  completedJobs: 3,
  status: UserStatus.ACTIVE,
  skills: ['Rust'],
  socialLinks: { github: 'https://github.com/alice' },
  totalEarned: '10',
  totalSpent: '0',
  isVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  lastActiveAt: '2026-01-03T00:00:00.000Z',
};

describe('user profile mapper', () => {
  describe('toPublicProfile', () => {
    it('keeps every public field and drops the email', () => {
      const { email, ...expected } = PROFILE;

      const result = toPublicProfile(PROFILE);

      expect(email).toBe(EMAIL);
      expect(result).toEqual(expected);
      expect(result).not.toHaveProperty('email');
    });

    it('is an allow-list: fields added to the stored profile later stay private', () => {
      const withInternalField = { ...PROFILE, internalNote: 'do not leak' } as UserProfile;

      const result = toPublicProfile(withInternalField);

      expect(result).not.toHaveProperty('internalNote');
      expect(JSON.stringify(result)).not.toContain('do not leak');
      expect(JSON.stringify(result)).not.toContain(EMAIL);
    });

    it('does not mutate the stored profile', () => {
      const copy = { ...PROFILE };

      toPublicProfile(PROFILE);

      expect(PROFILE).toEqual(copy);
    });
  });

  describe('toOwnerProfile', () => {
    it('is the public view plus the email', () => {
      expect(toOwnerProfile(PROFILE)).toEqual({ ...toPublicProfile(PROFILE), email: EMAIL });
    });
  });

  describe('toProfileForViewer', () => {
    it('returns the owner view for the profile's own wallet', () => {
      expect(toProfileForViewer(PROFILE, WALLET)).toHaveProperty('email', EMAIL);
    });

    it('returns the public view for any other wallet', () => {
      expect(toProfileForViewer(PROFILE, OTHER_WALLET)).not.toHaveProperty('email');
    });

    it('returns the public view when the viewer is unknown', () => {
      expect(toProfileForViewer(PROFILE, undefined)).not.toHaveProperty('email');
      expect(toProfileForViewer(PROFILE)).not.toHaveProperty('email');
    });
  });

  describe('toPublicProfilePage', () => {
    it('maps every entry and keeps the total', () => {
      const page = toPublicProfilePage({
        data: [PROFILE, { ...PROFILE, id: 'profile-2' }],
        total: 7,
      });

      expect(page.total).toBe(7);
      expect(page.data.map(p => p.id)).toEqual(['profile-1', 'profile-2']);
      expect(JSON.stringify(page)).not.toContain(EMAIL);
    });
  });
});
