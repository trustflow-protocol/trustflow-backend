import { Injectable } from '@nestjs/common';
import { EscrowService } from './escrow.service';
import { generateId } from './util.helper';

export interface DeliverableRevision {
  id: string;
  milestoneId: string;
  revisionNumber: number;
  fileRef: string;
  submittedBy: string;
  submitterComments?: string;
  status: 'submitted' | 'approved' | 'rejected';
  reviewerComments?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  submittedAt: string;
}

/**
 * Manages deliverable submissions as an append-only revision history keyed by
 * milestone.
 *
 * Bug fix: previously resubmitting a deliverable after a rejection did an
 * UPDATE on the existing row, overwriting the previous (rejected) submission's
 * file reference and reviewer comments. Each submission is now retained as a
 * distinct revision so the full review history — including rejected attempts
 * and their reviewer feedback — remains visible for dispute resolution.
 */
@Injectable()
export class DeliverableService {
  /** Keyed by `${escrowId}:${milestoneId}` -> append-only list of revisions. */
  private revisions: Map<string, DeliverableRevision[]> = new Map();
  /** Flat index for O(1) lookup by revision id. */
  private revisionIndex: Map<string, DeliverableRevision> = new Map();

  constructor(private readonly escrowService: EscrowService) {}

  /**
   * Submit a deliverable for a milestone as a NEW revision (append-only).
   * The previous submission and its reviewer feedback remain in the history.
   */
  async submitDeliverable(
    escrowId: string,
    milestoneId: string,
    fileRef: string,
    submittedBy: string,
    submitterComments?: string,
  ): Promise<DeliverableRevision> {
    const escrow = await this.escrowService.findById(escrowId);
    if (!escrow) throw new Error('Escrow not found');

    const milestones = await this.escrowService.getMilestones(escrowId);
    const milestone = milestones.find(m => m.id === milestoneId);
    if (!milestone) throw new Error('Milestone not found');

    const key = this.key(escrowId, milestoneId);
    const history = this.revisions.get(key) ?? [];
    const revisionNumber = history.length + 1;

    const revision: DeliverableRevision = {
      id: generateId(`del-${revisionNumber}`),
      milestoneId,
      revisionNumber,
      fileRef,
      submittedBy,
      submitterComments,
      status: 'submitted',
      submittedAt: new Date().toISOString(),
    };

    // Append — never overwrite the previous revision.
    history.push(revision);
    this.revisions.set(key, history);
    this.revisionIndex.set(revision.id, revision);

    return revision;
  }

  /**
   * Review a deliverable revision. The original submission and its reviewer
   * feedback remain in the history as a distinct revision.
   */
  async reviewDeliverable(
    escrowId: string,
    revisionId: string,
    decision: 'approved' | 'rejected',
    reviewerAddress: string,
    reviewerComments?: string,
  ): Promise<DeliverableRevision> {
    const revision = this.revisionIndex.get(revisionId);
    if (!revision) throw new Error('Deliverable revision not found');
    if (revision.status !== 'submitted') {
      throw new Error(`Revision already ${revision.status}`);
    }

    // Verify the revision belongs to the stated escrow.
    const escrow = await this.escrowService.findById(escrowId);
    if (!escrow) throw new Error('Escrow not found');
    const milestones = await this.escrowService.getMilestones(escrowId);
    const milestone = milestones.find(m => m.id === revision.milestoneId);
    if (!milestone) throw new Error('Milestone not found');

    revision.status = decision;
    revision.reviewerComments = reviewerComments;
    revision.reviewedBy = reviewerAddress;
    revision.reviewedAt = new Date().toISOString();

    return revision;
  }

  /**
   * Returns the full append-only revision history for a milestone, including
   * rejected attempts and their reviewer feedback.
   */
  async getRevisions(escrowId: string, milestoneId: string): Promise<DeliverableRevision[]> {
    return this.revisions.get(this.key(escrowId, milestoneId)) ?? [];
  }

  /**
   * Returns the latest revision (current status) for a milestone.
   */
  async getLatestRevision(
    escrowId: string,
    milestoneId: string,
  ): Promise<DeliverableRevision | undefined> {
    const history = this.revisions.get(this.key(escrowId, milestoneId)) ?? [];
    return history[history.length - 1];
  }

  private key(escrowId: string, milestoneId: string): string {
    return `${escrowId}:${milestoneId}`;
  }
}
