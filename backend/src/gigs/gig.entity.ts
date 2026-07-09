export enum GigStatus {
  OPEN = 'open',
  PAUSED = 'paused',
  FILLED = 'filled',
  CLOSED = 'closed',
}

export interface GigListing {
  id: string;
  clientAddress: string;
  title: string;
  description: string;
  budgetXLM: string;
  category?: string;
  skills: string[];
  status: GigStatus;
  deadline?: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}
