import { Module } from '@nestjs/common';
import { UserProfileController } from './user-profile.controller';
import { UserProfileService } from './user-profile.service';
import { S3StorageService } from './s3-storage.service';

@Module({
  controllers: [UserProfileController],
  providers: [UserProfileService, S3StorageService],
  exports: [UserProfileService, S3StorageService],
})
export class UserProfileModule {}
