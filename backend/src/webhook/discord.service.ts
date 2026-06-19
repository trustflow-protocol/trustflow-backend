import { Injectable, Logger } from '@nestjs/common';
import * as https from 'https';

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
  private readonly logger = new Logger(DiscordService.name);
  private readonly webhookUrl: string;

  constructor() {
    this.webhookUrl = process.env.DISCORD_WEBHOOK_URL || '';
  }

  /**
   * Send a notification to Discord when a dispute needs jurors
   */
  async notifyDisputeNeedsJurors(disputeData: {
    escrowId: string;
    depositor: string;
    beneficiary: string;
    amountXLM: string;
    reason?: string;
  }): Promise<void> {
    if (!this.webhookUrl) {
      this.logger.warn('Discord webhook URL not configured. Skipping notification.');
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

    try {
      await this.sendWebhook(payload);
      this.logger.log(`Discord notification sent for dispute: ${disputeData.escrowId}`);
    } catch (error) {
      this.logger.error(`Failed to send Discord notification: ${error.message}`);
    }
  }

  private async sendWebhook(payload: DiscordWebhookPayload): Promise<void> {
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
      };

      const req = https.request(options, res => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`Discord webhook returned status ${res.statusCode}`));
        }
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  private truncateAddress(address: string): string {
    if (address.length <= 12) return address;
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }
}
