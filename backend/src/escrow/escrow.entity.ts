export enum EscrowStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  RELEASED = 'released',
  DISPUTED = 'disputed',
  CANCELLED = 'cancelled',
}

export enum MilestoneStatus {
  PENDING = 'pending',
  RELEASED = 'released',
}

export enum DeliverableStatus {
  SUBMITTED = 'submitted',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

export class MilestoneEntity {
  id!: string;
  title!: string;
  amountXLM!: string;
  status!: MilestoneStatus;
  releasedAt?: string;
  createdAt!: string;
}

/**
 * Append-only deliverable revision. Each submission (including rejected
 * attempts and their reviewer feedback) is retained as a distinct revision
 * so the full review history is preserved for dispute resolution.
 */
export class DeliverableRevisionEntity {
  id!: string;
  milestoneId!: string;
  revisionNumber!: number;
  fileRef!: string;
  submittedBy!: string;
  submitterComments?: string;
  status!: DeliverableStatus;
  reviewerComments?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  submittedAt!: string;
}

export class JurorEntity {
  address!: string;
  registeredAt!: string;
  active!: boolean;
}

/**
 * A juror assigned to a dispute. `conflictFlagged` records whether a prior
 * counterparty relationship with a disputant was detected at assignment time.
 */
export class JurorAssignmentEntity {
  escrowId!: string;
  jurorAddress!: string;
  assignedAt!: string;
  conflictFlagged!: boolean;
  conflictReason?: string;
}

export class EscrowEntity {
  id!: string;
  depositor!: string;
  beneficiary!: string;
  amountXLM!: string;
  /** Denormalized summary: sum of unreleased milestone amounts (or full amount when no milestones). */
  remainingAmount!: string;
  tokenAddress!: string;
  status!: EscrowStatus;
  contractEscrowId?: string;
  stellarTxHash?: string;
  createdAt!: Date;
  updatedAt!: Date;
  releaseDeadlineBlock?: number;
  /** Epoch-millis deadline used by the sweep to detect expired escrows. */
  releaseDeadlineMs?: number;
  milestones!: MilestoneEntity[];
}
