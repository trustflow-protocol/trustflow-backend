import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * User Profile Entity
 * Represents both freelancers and clients in the TrustFlow platform.
 * Each profile is uniquely identified by their Stellar wallet address.
 */

export enum UserType {
  FREELANCER = 'freelancer',
  CLIENT = 'client',
  BOTH = 'both',
}

export enum UserStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  SUSPENDED = 'suspended',
}

@Entity('user_profiles')
@Index(['walletAddress'], { unique: true })
@Index(['rating'])
@Index(['userType'])
@Index(['status'])
export class UserProfileEntity {
  /**
   * Unique identifier (UUID)
   */
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Stellar wallet address (G-prefixed, 56 characters)
   * Serves as the primary authentication identifier
   */
  @Column({ type: 'varchar', length: 56, unique: true })
  @Index()
  walletAddress: string;

  /**
   * Display name for the user
   */
  @Column({ type: 'varchar', length: 100 })
  name: string;

  /**
   * User biography/description
   */
  @Column({ type: 'text', nullable: true })
  bio?: string;

  /**
   * Type of user (freelancer, client, or both)
   */
  @Column({
    type: 'enum',
    enum: UserType,
    default: UserType.FREELANCER,
  })
  userType: UserType;

  /**
   * Profile image URL
   */
  @Column({ type: 'varchar', length: 500, nullable: true })
  avatarUrl?: string;

  /**
   * User's email address (optional)
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  email?: string;

  /**
   * Overall rating (0-5 scale)
   */
  @Column({ type: 'decimal', precision: 3, scale: 2, default: 0 })
  rating: number;

  /**
   * Total number of ratings received
   */
  @Column({ type: 'int', default: 0 })
  ratingCount: number;

  /**
   * Number of completed jobs/contracts
   */
  @Column({ type: 'int', default: 0 })
  completedJobs: number;

  /**
   * Account status
   */
  @Column({
    type: 'enum',
    enum: UserStatus,
    default: UserStatus.ACTIVE,
  })
  status: UserStatus;

  /**
   * Skills or expertise tags (for freelancers)
   */
  @Column({ type: 'simple-array', nullable: true })
  skills?: string[];

  /**
   * Social media links
   */
  @Column({ type: 'jsonb', nullable: true })
  socialLinks?: {
    twitter?: string;
    github?: string;
    linkedin?: string;
    website?: string;
  };

  /**
   * Total amount earned (in XLM) - for freelancers
   */
  @Column({ type: 'decimal', precision: 20, scale: 7, default: 0, nullable: true })
  totalEarned?: string;

  /**
   * Total amount spent (in XLM) - for clients
   */
  @Column({ type: 'decimal', precision: 20, scale: 7, default: 0, nullable: true })
  totalSpent?: string;

  /**
   * User verification status
   */
  @Column({ type: 'boolean', default: false })
  isVerified: boolean;

  /**
   * Timestamp when the profile was created
   */
  @CreateDateColumn()
  createdAt: Date;

  /**
   * Timestamp when the profile was last updated
   */
  @UpdateDateColumn()
  updatedAt: Date;

  /**
   * Timestamp of last activity
   */
  @Column({ type: 'timestamp', nullable: true })
  lastActiveAt?: Date;
}
