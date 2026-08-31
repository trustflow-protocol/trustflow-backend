import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
  HttpCode,
  HttpStatus,
  UseGuards,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiBody,
  ApiQuery,
  ApiBearerAuth,
  ApiConsumes,
} from '@nestjs/swagger';
import { UserProfileService } from './user-profile.service';
import {
  CreateUserProfileDto,
  UpdateUserProfileDto,
  RateUserDto,
  CreateUserProfileSchema,
  UpdateUserProfileSchema,
  RateUserSchema,
} from './user-profile.dto';
import { UserType, UserStatus } from './user-profile.entity';
import { JwtAuthGuard } from '../auth/auth.guard';
import { S3StorageService } from './s3-storage.service';

/**
 * Shape of `req.user` once `JwtAuthGuard` has run — see
 * `JwtStrategy.validate()` (src/auth/jwt.strategy.ts).
 */
interface AuthenticatedRequest {
  user: { address: string; sub: string };
}

@ApiTags('User Profiles')
@Controller('profiles')
export class UserProfileController {
  constructor(
    private readonly userProfileService: UserProfileService,
    private readonly s3StorageService: S3StorageService,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Create a new user profile',
    description:
      'Creates a new user profile for a freelancer or client. Requires authentication; ' +
      '`walletAddress` must match the wallet address on the authenticated JWT — you can only ' +
      'create a profile for the wallet you signed in with, not on behalf of another address.',
  })
  @ApiBody({
    description: 'User profile creation details',
    schema: {
      type: 'object',
      required: ['walletAddress', 'name', 'userType'],
      properties: {
        walletAddress: {
          type: 'string',
          description: 'Stellar wallet address (G-prefixed, 56 characters)',
          example: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        },
        name: {
          type: 'string',
          description: 'User display name',
          example: 'John Doe',
          minLength: 2,
          maxLength: 100,
        },
        bio: {
          type: 'string',
          description: 'User biography',
          example: 'Experienced blockchain developer with 5+ years in Web3',
          maxLength: 500,
        },
        userType: {
          type: 'string',
          enum: ['freelancer', 'client', 'both'],
          description: 'Type of user account',
          example: 'freelancer',
        },
        avatarUrl: {
          type: 'string',
          description: 'Profile image URL',
          example: 'https://example.com/avatar.jpg',
        },
        email: {
          type: 'string',
          description: 'Email address (optional)',
          example: 'john@example.com',
        },
        skills: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of skills (for freelancers)',
          example: ['Solidity', 'Rust', 'TypeScript', 'Smart Contracts'],
          maxItems: 20,
        },
        socialLinks: {
          type: 'object',
          properties: {
            twitter: { type: 'string', example: 'https://twitter.com/johndoe' },
            github: { type: 'string', example: 'https://github.com/johndoe' },
            linkedin: { type: 'string', example: 'https://linkedin.com/in/johndoe' },
            website: { type: 'string', example: 'https://johndoe.dev' },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Profile created successfully',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        walletAddress: { type: 'string' },
        name: { type: 'string' },
        bio: { type: 'string', nullable: true },
        userType: { type: 'string', enum: ['freelancer', 'client', 'both'] },
        avatarUrl: { type: 'string', nullable: true },
        email: { type: 'string', nullable: true },
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
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Invalid input data' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 403,
    description: 'walletAddress does not match the authenticated wallet',
  })
  @ApiResponse({ status: 409, description: 'Profile with this wallet address already exists' })
  async create(@Body() dto: CreateUserProfileDto, @Req() req: AuthenticatedRequest) {
    const validated = CreateUserProfileSchema.parse(dto);

    // The caller can only ever prove ownership of the wallet address on
    // their own JWT — trusting walletAddress straight from the body would
    // let anyone squat on someone else's real address before its owner
    // ever registers (see #205).
    if (validated.walletAddress !== req.user.address) {
      throw new ForbiddenException('walletAddress must match the authenticated wallet address');
    }

    return this.userProfileService.create(validated);
  }

  @Get()
  @ApiOperation({
    summary: 'Get all user profiles',
    description: 'Retrieves all user profiles with optional filtering and pagination.',
  })
  @ApiQuery({
    name: 'userType',
    required: false,
    enum: UserType,
    description: 'Filter by user type',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: UserStatus,
    description: 'Filter by status',
  })
  @ApiQuery({
    name: 'minRating',
    required: false,
    type: Number,
    description: 'Minimum rating filter',
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    type: Number,
    description: 'Number of items to skip. Defaults to 0.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Maximum number of items to return (max 100). Defaults to 20.',
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of user profiles',
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              walletAddress: { type: 'string' },
              name: { type: 'string' },
              userType: { type: 'string' },
              rating: { type: 'number' },
              completedJobs: { type: 'number' },
              isVerified: { type: 'boolean' },
            },
          },
        },
        total: { type: 'number' },
      },
    },
  })
  async findAll(
    @Query('userType') userType?: UserType,
    @Query('status') status?: UserStatus,
    @Query('minRating') minRating?: number,
    @Query('offset') offset?: number,
    @Query('limit') limit?: number,
  ) {
    const safeOffset = Math.max(0, Number(offset) || 0);
    const safeLimit = Math.min(Math.max(1, Number(limit) || 20), 100);
    return this.userProfileService.findAll({
      userType,
      status,
      minRating: minRating ? parseFloat(minRating.toString()) : undefined,
      offset: safeOffset,
      limit: safeLimit,
    });
  }

  @Get('search')
  @ApiOperation({
    summary: 'Search user profiles',
    description: 'Search profiles by name, bio, or skills. Results are ranked by relevance.',
  })
  @ApiQuery({
    name: 'q',
    required: true,
    type: String,
    description: 'Search query',
    example: 'blockchain developer',
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    type: Number,
    description: 'Number of items to skip. Defaults to 0.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Maximum number of items to return (max 100). Defaults to 20.',
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated search results ranked by relevance',
  })
  async search(
    @Query('q') query: string,
    @Query('offset') offset?: number,
    @Query('limit') limit?: number,
  ) {
    const safeOffset = Math.max(0, Number(offset) || 0);
    const safeLimit = Math.min(Math.max(1, Number(limit) || 20), 100);
    return this.userProfileService.search(query, { offset: safeOffset, limit: safeLimit });
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get profile by ID',
    description: 'Retrieves a user profile by its unique ID.',
  })
  @ApiParam({
    name: 'id',
    description: 'Profile ID (UUID)',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 200,
    description: 'Profile details',
  })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async findById(@Param('id') id: string) {
    return this.userProfileService.findById(id);
  }

  @Get('wallet/:address')
  @ApiOperation({
    summary: 'Get profile by wallet address',
    description: 'Retrieves a user profile by their Stellar wallet address.',
  })
  @ApiParam({
    name: 'address',
    description: 'Stellar wallet address',
    example: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  })
  @ApiResponse({
    status: 200,
    description: 'Profile details',
  })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async findByWalletAddress(@Param('address') address: string) {
    return this.userProfileService.findByWalletAddress(address);
  }

  @Put(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update user profile',
    description: 'Updates an existing user profile. Requires authentication.',
  })
  @ApiParam({
    name: 'id',
    description: 'Profile ID',
  })
  @ApiBody({
    description: 'Profile update fields',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 2, maxLength: 100 },
        bio: { type: 'string', maxLength: 500 },
        userType: { type: 'string', enum: ['freelancer', 'client', 'both'] },
        avatarUrl: { type: 'string' },
        email: { type: 'string' },
        skills: { type: 'array', items: { type: 'string' } },
        socialLinks: { type: 'object' },
        status: { type: 'string', enum: ['active', 'inactive', 'suspended'] },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Profile updated successfully',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async update(@Param('id') id: string, @Body() dto: UpdateUserProfileDto) {
    const validated = UpdateUserProfileSchema.parse(dto);
    return this.userProfileService.update(id, validated);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete user profile',
    description: 'Deletes a user profile. Requires authentication.',
  })
  @ApiParam({
    name: 'id',
    description: 'Profile ID',
  })
  @ApiResponse({
    status: 204,
    description: 'Profile deleted successfully',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async delete(@Param('id') id: string) {
    await this.userProfileService.delete(id);
  }

  @Post(':id/rate')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Rate a user',
    description: 'Submit a rating for a user profile. Requires authentication.',
  })
  @ApiParam({
    name: 'id',
    description: 'Profile ID to rate',
  })
  @ApiBody({
    description: 'Rating details',
    schema: {
      type: 'object',
      required: ['walletAddress', 'rating'],
      properties: {
        walletAddress: {
          type: 'string',
          description: 'Wallet address of the rater',
        },
        rating: {
          type: 'number',
          minimum: 1,
          maximum: 5,
          description: 'Rating value (1-5)',
          example: 5,
        },
        review: {
          type: 'string',
          maxLength: 1000,
          description: 'Optional review text',
          example: 'Excellent work, delivered on time!',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Rating submitted successfully',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async rateUser(@Param('id') id: string, @Body() dto: RateUserDto) {
    const validated = RateUserSchema.parse(dto);
    return this.userProfileService.rateUser(id, validated);
  }

  @Post(':id/verify')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Verify a user profile',
    description: 'Marks a user profile as verified. Admin only.',
  })
  @ApiParam({
    name: 'id',
    description: 'Profile ID',
  })
  @ApiResponse({
    status: 200,
    description: 'Profile verified successfully',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async verifyUser(@Param('id') id: string) {
    return this.userProfileService.verifyUser(id);
  }

  @Post(':id/avatar')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('file'))
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Upload avatar image',
    description:
      'Uploads a profile picture to S3-compatible storage and updates the user profile. ' +
      'Accepts JPEG, PNG, or WebP images up to 5MB.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'Avatar image file (JPEG, PNG, or WebP, max 5MB)',
        },
      },
    },
  })
  @ApiParam({ name: 'id', description: 'Profile ID' })
  @ApiResponse({ status: 200, description: 'Avatar uploaded successfully' })
  @ApiResponse({ status: 400, description: 'Invalid file type or size' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async uploadAvatar(@Param('id') id: string, @UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    const allowedMimes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedMimes.includes(file.mimetype)) {
      throw new BadRequestException('Only JPEG, PNG, and WebP images are allowed');
    }

    const maxSize = 5 * 1024 * 1024; // 5MB
    if (file.size > maxSize) {
      throw new BadRequestException('File size must not exceed 5MB');
    }

    const result = await this.s3StorageService.uploadAvatar(
      file.buffer,
      file.originalname,
      file.mimetype,
    );

    await this.userProfileService.update(id, { avatarUrl: result.url });

    return { avatarUrl: result.url, key: result.key };
  }
}
