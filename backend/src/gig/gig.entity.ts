/** Lifecycle status of a gig solicitation. */
export enum GigStatus {
  /** Posted and awaiting a response. */
  OPEN = 'open',
  /** A responder accepted before the response window elapsed. */
  ACCEPTED = 'accepted',
  /** Nobody accepted before the response window elapsed. */
  EXPIRED = 'expired',
  /** Withdrawn by the creator before the response window elapsed. */
  CANCELLED = 'cancelled',
}

export interface Gig {
  id: string;
  creator: string;
  title: string;
  budgetXLM: string;
  status: GigStatus;
  createdAt: string;
  /** Deadline by which the gig must be accepted, after which the expiry sweep marks it EXPIRED. */
  respondBy: string;
  acceptedBy?: string;
  acceptedAt?: string;
  expiredAt?: string;
  cancelledAt?: string;
}

/** Webhook events emitted by the gig service and expiry sweep worker. */
export const GIG_EVENTS = {
  GIG_CREATED: 'gig.created',
  GIG_ACCEPTED: 'gig.accepted',
  GIG_EXPIRED: 'gig.expired',
  GIG_CANCELLED: 'gig.cancelled',
} as const;

export const DEFAULT_RESPONSE_WINDOW_HOURS = 72;
export const DEFAULT_GIG_EXPIRY_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
