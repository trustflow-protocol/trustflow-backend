export enum NotificationType {
  DISPUTE_ESCALATED = 'dispute_escalated',
  JURORS_ASSIGNED = 'jurors_assigned',
  DISPUTE_VOTE_CAST = 'dispute_vote_cast',
  DISPUTE_VERDICT_REACHED = 'dispute_verdict_reached',
  DISPUTE_PAYOUT_EXECUTED = 'dispute_payout_executed',
}

export interface NotificationPayload {
  type: NotificationType;
  recipientAddress: string;
  disputeId: string;
  escrowId: string;
  message: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface NotificationChannel {
  send(payload: NotificationPayload): Promise<void>;
}
