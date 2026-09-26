import { Module } from '@nestjs/common';
import { UserProfileController } from './user-profile.controller';
import { UserProfileService } from './user-profile.service';
import { S3StorageService } from './s3-storage.service';
import { MonitoringModule } from '../monitoring/monitoring.module';

@Module({
  imports: [MonitoringModule],
  controllers: [UserProfileController],
  providers: [UserProfileService, S3StorageService],
  exports: [UserProfileService, S3StorageService],
})
export class UserProfileModule {}
