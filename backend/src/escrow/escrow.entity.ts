export enum EscrowStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  RELEASED = 'released',
  DISPUTED = 'disputed',
  CANCELLED = 'cancelled',
}

export class EscrowEntity {
  id: string;
  depositor: string;
  beneficiary: string;
  amountXLM: string;
  tokenAddress: string;
  status: EscrowStatus;
  contractEscrowId?: string;
  stellarTxHash?: string;
  createdAt: Date;
  updatedAt: Date;
  releaseDeadlineBlock?: number;
}
