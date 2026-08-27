import { Injectable, Logger } from '@nestjs/common';
import * as https from 'https';
import * as http from 'http';

export interface UploadResult {
  url: string;
  key: string;
}

export interface StorageProvider {
  upload(key: string, body: Buffer, contentType: string): Promise<UploadResult>;
  delete(key: string): Promise<void>;
  getSignedUrl(key: string, expiresIn?: number): Promise<string>;
}

/**
 * S3-compatible storage service for avatar uploads.
 *
 * Uses a pluggable StorageProvider so the actual S3 client can be swapped
 * (AWS S3, MinIO, Cloudflare R2, etc.) without changing the rest of the app.
 * When no provider is configured, falls back to a no-op that returns a
 * placeholder URL — useful for local dev and testing.
 */
@Injectable()
export class S3StorageService {
  private readonly logger = new Logger(S3StorageService.name);
  private provider: StorageProvider | null = null;

  registerProvider(provider: StorageProvider): void {
    this.provider = provider;
  }

  async uploadAvatar(
    fileBuffer: Buffer,
    originalName: string,
    contentType: string,
  ): Promise<UploadResult> {
    const key = this.generateKey(originalName);

    if (!this.provider) {
      this.logger.warn('No storage provider configured — returning placeholder URL');
      return {
        url: `https://placeholder.trustflow.xyz/avatars/${key}`,
        key,
      };
    }

    return this.provider.upload(key, fileBuffer, contentType);
  }

  async deleteAvatar(key: string): Promise<void> {
    if (!this.provider) {
      this.logger.warn('No storage provider configured — skipping delete');
      return;
    }
    return this.provider.delete(key);
  }

  async getAvatarUrl(key: string, expiresIn?: number): Promise<string> {
    if (!this.provider) {
      return `https://placeholder.trustflow.xyz/avatars/${key}`;
    }
    return this.provider.getSignedUrl(key, expiresIn);
  }

  private generateKey(originalName: string): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).slice(2, 10);
    const ext = originalName.split('.').pop() || 'jpg';
    return `avatars/${timestamp}-${random}.${ext}`;
  }
}
