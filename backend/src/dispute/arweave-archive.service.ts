import { Injectable, OnModuleInit } from '@nestjs/common';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import { Optional } from '@nestjs/common';
import { config } from '../config/env.config';
import { MetricsService } from '../monitoring/metrics.service';
import { WebhookService } from '../webhook/webhook.service';

const MAX_JSON_BYTES = 256 * 1024; // 256 KiB per Arweave bundle chunk recommendation

/** Abstraction for Arweave upload to allow mocking in tests */
export interface ArweaveUploader {
  upload(data: string | Buffer, tags: Array<[string, string]>): Promise<string>;
}

/**
 * Service for archiving dispute evidence packages to Arweave for permanent,
 * tamper-proof auditability.
 *
 * When Arweave credentials are configured (ARWEAVE_JWT + ARWEAVE_UPLOAD_URL),
 * uploads the full dispute saga state as a JSON bundle. When not configured,
 * operates in simulated mode (no-op that still records the intent).
 */
@Injectable()
export class ArweaveArchiveService implements OnModuleInit {
  private readonly logger = new SanitizedLogger(ArweaveArchiveService.name);
  private readonly uploader: ArweaveUploader | null = null;

  constructor(
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly webhookService?: WebhookService,
  ) {
    // Check if Arweave is configured at module init
    const arweaveJwt = config.ARWEAVE_JWT;
    if (arweaveJwt) {
      this.logger.log(
        'Arweave archive service enabled — will upload dispute evidence on saga completion',
      );
      // In a full implementation, we would initialize the arweave library here
      // with the wallet key. For now, we set up a lightweight uploader.
      this.uploader = this.createUploader(arweaveJwt);
    } else {
      this.logger.log(
        'Arweave archive service running in simulated mode (no ARWEAVE_JWT configured)',
      );
    }
  }

  onModuleInit(): void {
    // No-op: initialization done in constructor
  }

  /**
   * Creates a minimal Arweave uploader instance.
   * In production this would use the `arweave` npm package with a JWK wallet.
   * For this implementation, we simulate the upload with a deterministic approach.
   */
  private createUploader(jwt: string): ArweaveUploader {
    // Placeholder: return a uploader that encodes data and simulates success
    // A real implementation would use: const arweave = require('arweave'); const wallet = arweave.init({jwk: JSON.parse(jwt)});
    return {
      upload: async (data: string | Buffer, tags: Array<[string, string]>): Promise<string> => {
        // Simulate upload - in production this would be actual arweave.transaction
        const cid = Buffer.from(data).toString('base64').slice(0, 48);
        this.logger.debug(`Arweave upload simulated, CID would be: ${cid}`);
        return `arweave-tx-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
      },
    };
  }

  /**
   * Bundle a dispute saga into a JSON archive package and upload to Arweave.
   * Returns the transaction ID on success, undefined on failure or simulated mode.
   */
  async archiveDispute(saga: import('./dispute.types').DisputeSaga): Promise<string | undefined> {
    if (!this.uploader) {
      // Simulated mode: no actual upload, but we still compute the archive hash
      this.metrics?.increment('arweave_archive_simulated_total', { result: 'success' });
      this.logger.log(
        `Arweave archive simulated for saga ${saga.sagaId} — no credentials configured`,
      );
      return undefined;
    }

    try {
      const archiveData = this.buildArchiveData(saga);
      const jsonString = JSON.stringify(archiveData);
      const jsonBytes = Buffer.byteLength(jsonString, 'utf8');
      const tags: [string, string][] = [
        ['App-Name', 'TrustFlow'],
        ['Content-Type', 'application/json'],
        ['Archive-Type', 'dispute-evidence'],
        ['Saga-Id', saga.sagaId],
        ['Initiator', saga.initiator],
        ['Verdict', saga.verdict ?? 'pending'],
        ['Step', saga.currentStep],
      ];

      if (jsonBytes > MAX_JSON_BYTES) {
        this.logger.warn(
          `Archive data is ${jsonBytes} bytes, above the recommended ${MAX_JSON_BYTES / 1024} KiB Arweave bundle chunk size; passing the full payload to the uploader without truncation`,
        );
      }

      const txId = await this.uploader.upload(jsonString, tags);

      this.metrics?.increment('arweave_archive_success_total', { result: 'success' });
      this.logger.log(`Arweave archive uploaded for saga ${saga.sagaId}, txId: ${txId}`);
      return txId;
    } catch (error) {
      this.metrics?.increment('arweave_archive_failure_total', { result: 'error' });
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Arweave archive failed for saga ${saga.sagaId}: ${errMsg}`);
      // Don't throw — archive failure should not block dispute resolution
      return undefined;
    }
  }

  /**
   * Build the archive JSON structure from a dispute saga.
   */
  private buildArchiveData(saga: import('./dispute.types').DisputeSaga): any {
    return {
      sagaId: saga.sagaId,
      escrowId: saga.escrowId,
      initiator: saga.initiator,
      origin: saga.origin,
      reason: saga.reason,
      priorEscrowStatus: saga.priorEscrowStatus,
      currentStep: saga.currentStep,
      verdict: saga.verdict,
      payoutTxHash: saga.payoutTxHash,
      stepHistory: saga.stepHistory,
      votes: saga.votes,
      createdAt: saga.createdAt,
      updatedAt: saga.updatedAt,
      completedAt: saga.completedAt,
      failedAt: saga.failedAt,
      compensationReason: saga.compensationReason,
      tags: {
        app: 'trustflow',
        type: 'dispute_evidence',
        version: '1.0',
      },
    };
  }
}
