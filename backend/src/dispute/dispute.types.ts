export enum DisputeStep {
  PENDING = 'PENDING',
  ESCALATION = 'ESCALATION',
  JUROR_ASSIGNMENT = 'JUROR_ASSIGNMENT',
  VOTING = 'VOTING',
  PAYOUT = 'PAYOUT',
  COMPLETED = 'COMPLETED',
  COMPENSATING = 'COMPENSATING',
  FAILED = 'FAILED',
}

export enum DisputeVerdict {
  DEPOSITOR_WINS = 'DEPOSITOR_WINS',
  BENEFICIARY_WINS = 'BENEFICIARY_WINS',
  SPLIT = 'SPLIT',
}

export interface JurorVote {
  jurorAddress: string;
  vote: 'depositor' | 'beneficiary' | 'split';
  castAt: string;
}

export interface SagaStepRecord {
  step: DisputeStep;
  startedAt: string;
  completedAt?: string;
  failedAt?: string;
  compensatedAt?: string;
  error?: string;
}

export interface DisputeSaga {
  sagaId: string;
  escrowId: string;
  initiator: string;
  reason: string;
  currentStep: DisputeStep;
  escalationTxHash?: string;
  assignedJurors?: string[];
  votes?: JurorVote[];
  verdict?: DisputeVerdict;
  payoutTxHash?: string;
  stepHistory: SagaStepRecord[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  failedAt?: string;
  compensationReason?: string;
}
