import { Injectable, Logger } from '@nestjs/common';
import { NotificationType, NotificationPayload, NotificationChannel } from './notification.types';

/**
 * Dispatches dispute-resolution notifications to the right parties via pluggable channels.
 *
 * Channels (email, in-app, push) are registered at startup — the service fans out each
 * notification to every registered channel. Adding a new delivery mechanism means writing
 * a small adapter that implements NotificationChannel and registering it; nothing else changes.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private readonly channels: NotificationChannel[] = [];

  registerChannel(channel: NotificationChannel): void {
    this.channels.push(channel);
  }

  async notifyDisputeEscalated(data: {
    escrowId: string;
    disputeId: string;
    depositor: string;
    beneficiary: string;
    reason: string;
  }): Promise<void> {
    const message = `A dispute has been raised on escrow ${data.escrowId}. Reason: ${data.reason}`;
    await Promise.allSettled([
      this.sendToAddress(data.depositor, {
        type: NotificationType.DISPUTE_ESCALATED,
        recipientAddress: data.depositor,
        disputeId: data.disputeId,
        escrowId: data.escrowId,
        message,
        metadata: { reason: data.reason, counterpart: data.beneficiary },
        createdAt: new Date().toISOString(),
      }),
      this.sendToAddress(data.beneficiary, {
        type: NotificationType.DISPUTE_ESCALATED,
        recipientAddress: data.beneficiary,
        disputeId: data.disputeId,
        escrowId: data.escrowId,
        message,
        metadata: { reason: data.reason, counterpart: data.depositor },
        createdAt: new Date().toISOString(),
      }),
    ]);
  }

  async notifyJurorsAssigned(data: {
    disputeId: string;
    escrowId: string;
    jurors: string[];
  }): Promise<void> {
    const message = `You have been assigned as a juror for dispute ${data.disputeId} (escrow ${data.escrowId}). Please review and cast your vote.`;
    await Promise.allSettled(
      data.jurors.map(juror =>
        this.sendToAddress(juror, {
          type: NotificationType.JURORS_ASSIGNED,
          recipientAddress: juror,
          disputeId: data.disputeId,
          escrowId: data.escrowId,
          message,
          metadata: { allJurors: data.jurors },
          createdAt: new Date().toISOString(),
        }),
      ),
    );
  }

  async notifyVerdictReached(data: {
    disputeId: string;
    escrowId: string;
    verdict: string;
    depositor: string;
    beneficiary: string;
  }): Promise<void> {
    const depositorMsg = `Dispute ${data.disputeId} verdict: ${data.verdict}. ${
      data.verdict.includes('DEPOSITOR') ? 'You won the dispute.' : 'The verdict has been reached.'
    }`;
    const beneficiaryMsg = `Dispute ${data.disputeId} verdict: ${data.verdict}. ${
      data.verdict.includes('BENEFICIARY')
        ? 'You won the dispute.'
        : 'The verdict has been reached.'
    }`;

    await Promise.allSettled([
      this.sendToAddress(data.depositor, {
        type: NotificationType.DISPUTE_VERDICT_REACHED,
        recipientAddress: data.depositor,
        disputeId: data.disputeId,
        escrowId: data.escrowId,
        message: depositorMsg,
        metadata: { verdict: data.verdict },
        createdAt: new Date().toISOString(),
      }),
      this.sendToAddress(data.beneficiary, {
        type: NotificationType.DISPUTE_VERDICT_REACHED,
        recipientAddress: data.beneficiary,
        disputeId: data.disputeId,
        escrowId: data.escrowId,
        message: beneficiaryMsg,
        metadata: { verdict: data.verdict },
        createdAt: new Date().toISOString(),
      }),
    ]);
  }

  async notifyPayoutExecuted(data: {
    disputeId: string;
    escrowId: string;
    verdict: string;
    depositor: string;
    beneficiary: string;
  }): Promise<void> {
    const message = `Payout for dispute ${data.disputeId} has been executed (${data.verdict}).`;
    await Promise.allSettled([
      this.sendToAddress(data.depositor, {
        type: NotificationType.DISPUTE_PAYOUT_EXECUTED,
        recipientAddress: data.depositor,
        disputeId: data.disputeId,
        escrowId: data.escrowId,
        message,
        metadata: { verdict: data.verdict },
        createdAt: new Date().toISOString(),
      }),
      this.sendToAddress(data.beneficiary, {
        type: NotificationType.DISPUTE_PAYOUT_EXECUTED,
        recipientAddress: data.beneficiary,
        disputeId: data.disputeId,
        escrowId: data.escrowId,
        message,
        metadata: { verdict: data.verdict },
        createdAt: new Date().toISOString(),
      }),
    ]);
  }

  private async sendToAddress(address: string, payload: NotificationPayload): Promise<void> {
    if (this.channels.length === 0) {
      this.logger.warn(
        `No notification channels registered — dropping notification for ${this.maskAddress(address)}`,
      );
      return;
    }

    await Promise.allSettled(
      this.channels.map(channel =>
        channel.send(payload).catch(err => {
          this.logger.error(
            `Channel failed to notify ${this.maskAddress(address)}: ${err.message}`,
          );
        }),
      ),
    );
  }

  private maskAddress(address: string): string {
    if (address.length <= 12) return '****';
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }
}
