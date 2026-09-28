import { Injectable, Optional } from '@nestjs/common';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import * as https from 'https';
import { config } from '../config/env.config';
import { MetricsService } from '../monitoring/metrics.service';
import { withRetry, isRetryable } from './retry.helper';

interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  timestamp?: string;
}

interface DiscordWebhookPayload {
  content?: string;
  embeds?: DiscordEmbed[];
}

@Injectable()
export class DiscordService {
  private readonly logger = new SanitizedLogger(DiscordService.name);
  private readonly webhookUrl: string;
  /** Permanent failures that should not be retried. */
  private readonly failedNotifications = new Map<string, { error: string; timestamp: string }>();

  constructor(@Optional() private readonly metrics?: MetricsService) {
    this.webhookUrl = config.DISCORD_WEBHOOK_URL || '';
  }

  /**
   * Send a notification to Discord when a dispute needs jurors.
   * Retries transient failures with exponential backoff; permanent failures are recorded
   * in a dead-letter map (#394). Does not block the dispute request — returns immediately.
   */
  async notifyDisputeNeedsJurors(disputeData: {
    escrowId: string;
    depositor: string;
    beneficiary: string;
    amountXLM: string;
    reason?: string;
  }): Promise<void> {
    if (!this.webhookUrl) {
      this.logger.debug('Discord webhook URL not configured. Skipping notification.');
      return;
    }

    const embed: DiscordEmbed = {
      title: '⚖️ New Dispute Requires Jurors',
      description: `A dispute has been raised and requires community jurors to resolve.`,
      color: 0xff6b6b, // Red color
      fields: [
        { name: 'Escrow ID', value: disputeData.escrowId, inline: true },
        { name: 'Amount', value: `${disputeData.amountXLM} XLM`, inline: true },
        { name: 'Depositor', value: this.truncateAddress(disputeData.depositor), inline: true },
        { name: 'Beneficiary', value: this.truncateAddress(disputeData.beneficiary), inline: true },
      ],
      timestamp: new Date().toISOString(),
    };

    if (disputeData.reason) {
      embed.fields?.push({ name: 'Reason', value: disputeData.reason, inline: false });
    }

    const payload: DiscordWebhookPayload = {
      content: '@here A new dispute needs your attention!',
      embeds: [embed],
    };

    // Deliver asynchronously without blocking the request path
    this.sendWithRetry(payload, disputeData.escrowId).catch(error => {
      // Log permanent failure but don't throw (request is already in response path)
      this.logger.error(
        `Discord notification permanently failed for dispute ${disputeData.escrowId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  /**
   * Attempt to send a notification with exponential backoff retry on transient failures.
   * Permanent failures (4xx except 429, configuration errors) are recorded in dead-letter.
   */
  private async sendWithRetry(payload: DiscordWebhookPayload, disputeId: string): Promise<void> {
    const maxAttempts = config.DISCORD_NOTIFICATION_MAX_RETRIES;
    const baseDelayMs = config.DISCORD_NOTIFICATION_RETRY_BASE_DELAY_MS;

    try {
      await withRetry(
        () => this.sendWebhook(payload, disputeId),
        maxAttempts,
        baseDelayMs,
        error => {
          const retryable = isRetryable(error);
          const message = error instanceof Error ? error.message : String(error);
          this.logger.debug(
            `Discord notification for ${disputeId}: ${retryable ? 'retryable' : 'permanent'} error: ${message}`,
          );
          return retryable;
        },
      );
      this.logger.log(`Discord notification delivered for dispute: ${disputeId}`);
      this.metrics?.increment('discord_notifications_sent_total');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.failedNotifications.set(disputeId, {
        error: message,
        timestamp: new Date().toISOString(),
      });
      this.metrics?.increment('discord_notifications_failed_total', { reason: 'permanent' });
      throw error; // Re-throw so caller knows delivery ultimately failed
    }
  }

  /** Milliseconds to wait for a Discord webhook response before aborting. */
  static readonly WEBHOOK_TIMEOUT_MS = 5_000;

  private async sendWebhook(payload: DiscordWebhookPayload, disputeId?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const url = new URL(this.webhookUrl);

      const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: DiscordService.WEBHOOK_TIMEOUT_MS,
      };

      const req = https.request(options, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            let errorMsg = `Discord webhook returned status ${res.statusCode}`;
            // Try to extract error details from Discord response
            const responseBody = Buffer.concat(chunks).toString('utf8');
            if (responseBody && res.statusCode === 429) {
              errorMsg += ' (rate limited)';
            } else if (responseBody) {
              try {
                const response = JSON.parse(responseBody);
                if (response.message) {
                  errorMsg += `: ${response.message}`;
                }
              } catch {
                // Ignore parse errors, use default message
              }
            }
            reject(new Error(errorMsg));
          }
        });
      });

      req.on('timeout', () => {
        req.destroy(
          new Error(`Discord webhook timed out after ${DiscordService.WEBHOOK_TIMEOUT_MS}ms`),
        );
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  /** Returns the current dead-letter list of permanently failed notifications. */
  getFailedNotifications(): Map<string, { error: string; timestamp: string }> {
    return this.failedNotifications;
  }

  private truncateAddress(address: string): string {
    if (address.length <= 12) return address;
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }
}
