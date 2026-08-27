export enum DeliverableStatus {
  PENDING = 'pinned',
  PINNED = 'pinned',
  FAILED = 'failed',
}

export interface Deliverable {
  id: string;
  gigId: string;
  freelancer: string;
  cid: string;
  filename: string;
  size: number;
  status: DeliverableStatus;
  createdAt: string;
  updatedAt: string;
}

export const DELIVERABLE_EVENTS = {
  DELIVERABLE_UPLOADED: 'deliverable.uploaded',
} as const;
