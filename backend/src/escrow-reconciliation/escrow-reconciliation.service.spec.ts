import { EscrowReconciliationService } from './escrow-reconciliation.service';
import { EscrowService, Escrow } from '../escrow/escrow.service';
import { WebhookService } from '../webhook/webhook.service';
import { EscrowChainStateClient } from './escrow-chain-state.client';
import { EscrowReconciliationStateStore } from './escrow-reconciliation-state.store';
import { InvalidChainStateError } from './chain-escrow.validation';
import { ChainEscrowRecord, DriftType, RECONCILIATION_EVENTS } from './escrow-reconciliation.types';

function makeEscrow(overrides: Partial<Escrow> = {}): Escrow {
  return {
    id: 'esc-1',
    depositor: `G${'A'.repeat(55)}`,
    beneficiary: `G${'B'.repeat(55)}`,
    amountXLM: '100',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    contractEscrowId: 'chain-esc-1',
    ...overrides,
  };
}

function makeChainRecord(overrides: Partial<ChainEscrowRecord> = {}): ChainEscrowRecord {
  return {
    contractEscrowId: 'chain-esc-1',
    depositor: `G${'A'.repeat(55)}`,
    beneficiary: `G${'B'.repeat(55)}`,
    amountXLM: '100',
    status: 'active',
    ...overrides,
  };
}

describe('EscrowReconciliationService', () => {
  let escrowService: jest.Mocked<
    Pick<
      EscrowService,
      'findAll' | 'applyChainState' | 'createFromChainState' | 'findByContractEscrowId'
    >
  >;
  let chainClient: jest.Mocked<EscrowChainStateClient>;
  let webhookService: jest.Mocked<Pick<WebhookService, 'dispatch'>>;
  let store: EscrowReconciliationStateStore;
  let service: EscrowReconciliationService;

  beforeEach(() => {
    escrowService = {
      findAll: jest.fn().mockResolvedValue([]),
      applyChainState: jest.fn(),
      createFromChainState: jest.fn(),
      findByContractEscrowId: jest.fn(),
    };
    chainClient = { getEscrow: jest.fn() };
    webhookService = { dispatch: jest.fn().mockResolvedValue(undefined) };
    store = new EscrowReconciliationStateStore();

    service = new EscrowReconciliationService(
      escrowService as unknown as EscrowService,
      chainClient,
      webhookService as unknown as WebhookService,
      store,
    );
  });

  describe('no drift', () => {
    it('reports zero drift when DB and chain agree, and skips the webhook', async () => {
      escrowService.findAll.mockResolvedValue([makeEscrow()]);
      chainClient.getEscrow.mockResolvedValue(makeChainRecord());

      const run = await service.reconcile();

      expect(run.checked).toBe(1);
      expect(run.driftCount).toBe(0);
      expect(run.drifts).toEqual([]);
      expect(escrowService.applyChainState).not.toHaveBeenCalled();
      expect(webhookService.dispatch).not.toHaveBeenCalled();
    });

    it('ignores DB escrows that are not yet linked to a contract id', async () => {
      escrowService.findAll.mockResolvedValue([makeEscrow({ contractEscrowId: undefined })]);

      const run = await service.reconcile();

      expect(run.checked).toBe(0);
      expect(chainClient.getEscrow).not.toHaveBeenCalled();
    });
  });

  describe('status mismatch', () => {
    it('detects and repairs a status drift by trusting chain state', async () => {
      const escrow = makeEscrow({ status: 'active' });
      escrowService.findAll.mockResolvedValue([escrow]);
      chainClient.getEscrow.mockResolvedValue(makeChainRecord({ status: 'released' }));
      escrowService.applyChainState.mockResolvedValue({ ...escrow, status: 'released' });

      const run = await service.reconcile();

      expect(run.driftCount).toBe(1);
      expect(run.repairedCount).toBe(1);
      expect(run.drifts[0]).toMatchObject({
        driftType: DriftType.STATUS_MISMATCH,
        contractEscrowId: 'chain-esc-1',
        repaired: true,
      });
      expect(escrowService.applyChainState).toHaveBeenCalledWith(escrow.id, {
        status: 'released',
        amountXLM: '100',
      });
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        RECONCILIATION_EVENTS.DRIFT_DETECTED,
        expect.objectContaining({ driftCount: 1 }),
      );
    });
  });

  describe('amount mismatch', () => {
    it('detects and repairs an amount drift', async () => {
      const escrow = makeEscrow({ amountXLM: '100' });
      escrowService.findAll.mockResolvedValue([escrow]);
      chainClient.getEscrow.mockResolvedValue(makeChainRecord({ amountXLM: '250' }));
      escrowService.applyChainState.mockResolvedValue({ ...escrow, amountXLM: '250' });

      const run = await service.reconcile();

      expect(run.drifts).toHaveLength(1);
      expect(run.drifts[0]).toMatchObject({ driftType: DriftType.AMOUNT_MISMATCH, repaired: true });
    });
  });

  describe('status and amount both drift', () => {
    it('records both field drifts but repairs them with a single write', async () => {
      const escrow = makeEscrow({ status: 'active', amountXLM: '100' });
      escrowService.findAll.mockResolvedValue([escrow]);
      chainClient.getEscrow.mockResolvedValue(
        makeChainRecord({ status: 'disputed', amountXLM: '300' }),
      );
      escrowService.applyChainState.mockResolvedValue({
        ...escrow,
        status: 'disputed',
        amountXLM: '300',
      });

      const run = await service.reconcile();

      expect(run.drifts.map(d => d.driftType).sort()).toEqual(
        [DriftType.STATUS_MISMATCH, DriftType.AMOUNT_MISMATCH].sort(),
      );
      expect(run.drifts.every(d => d.repaired)).toBe(true);
      expect(escrowService.applyChainState).toHaveBeenCalledTimes(1);
    });
  });

  describe('missing on chain', () => {
    it('flags the drift but does not attempt to repair it automatically', async () => {
      escrowService.findAll.mockResolvedValue([makeEscrow()]);
      chainClient.getEscrow.mockResolvedValue(undefined);

      const run = await service.reconcile();

      expect(run.drifts).toHaveLength(1);
      expect(run.drifts[0]).toMatchObject({
        driftType: DriftType.MISSING_ON_CHAIN,
        repaired: false,
      });
      expect(escrowService.applyChainState).not.toHaveBeenCalled();
    });
  });

  describe('missing in DB', () => {
    it('backfills a DB row for a candidate contract id found on chain but untracked', async () => {
      const chainOnly = makeChainRecord({
        contractEscrowId: 'chain-esc-orphan',
        status: 'pending',
      });
      chainClient.getEscrow.mockResolvedValue(chainOnly);
      escrowService.createFromChainState.mockResolvedValue(
        makeEscrow({ id: 'esc-new', contractEscrowId: 'chain-esc-orphan', status: 'pending' }),
      );

      const run = await service.reconcile(['chain-esc-orphan']);

      expect(run.drifts).toHaveLength(1);
      expect(run.drifts[0]).toMatchObject({ driftType: DriftType.MISSING_IN_DB, repaired: true });
      expect(escrowService.createFromChainState).toHaveBeenCalledWith(chainOnly);
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        RECONCILIATION_EVENTS.ESCROW_BACKFILLED,
        expect.objectContaining({ contractEscrowId: 'chain-esc-orphan' }),
      );
    });

    it('skips candidate ids already linked to a DB row', async () => {
      escrowService.findAll.mockResolvedValue([makeEscrow({ contractEscrowId: 'chain-esc-1' })]);
      chainClient.getEscrow.mockResolvedValue(makeChainRecord());

      const run = await service.reconcile(['chain-esc-1']);

      // only the one DB-linked check happens; the candidate id is not re-fetched a second time
      expect(chainClient.getEscrow).toHaveBeenCalledTimes(1);
      expect(run.checked).toBe(1);
    });

    it('does nothing when a candidate id exists on neither side', async () => {
      chainClient.getEscrow.mockResolvedValue(undefined);

      const run = await service.reconcile(['chain-esc-nowhere']);

      expect(run.drifts).toEqual([]);
      expect(escrowService.createFromChainState).not.toHaveBeenCalled();
    });
  });

  describe('repair failure', () => {
    it('records the repair error without throwing, and still returns the run', async () => {
      const escrow = makeEscrow({ status: 'active' });
      escrowService.findAll.mockResolvedValue([escrow]);
      chainClient.getEscrow.mockResolvedValue(makeChainRecord({ status: 'released' }));
      escrowService.applyChainState.mockRejectedValue(new Error('write conflict'));

      const run = await service.reconcile();

      expect(run.drifts[0]).toMatchObject({ repaired: false, repairError: 'write conflict' });
      expect(run.repairedCount).toBe(0);
    });
  });

  describe('run history', () => {
    it('persists runs and returns them via findById/findAll', async () => {
      escrowService.findAll.mockResolvedValue([]);

      const run = await service.reconcile();

      expect(await service.findById(run.runId)).toEqual(run);
      expect(await service.findAll()).toEqual([run]);
    });
  });

  describe('invalid chain data', () => {
    it('records an unrepaired error against that escrow and never writes to the DB', async () => {
      escrowService.findAll.mockResolvedValue([
        makeEscrow(),
        makeEscrow({ id: 'esc-2', contractEscrowId: 'chain-esc-2' }),
      ]);
      chainClient.getEscrow
        .mockRejectedValueOnce(new InvalidChainStateError('chain-esc-1', 'unrecognised status'))
        .mockResolvedValueOnce(makeChainRecord({ contractEscrowId: 'chain-esc-2' }));

      const run = await service.reconcile();

      expect(escrowService.applyChainState).not.toHaveBeenCalled();
      expect(run.checked).toBe(2);
      expect(run.drifts).toHaveLength(1);
      expect(run.drifts[0]).toMatchObject({
        contractEscrowId: 'chain-esc-1',
        driftType: DriftType.INVALID_CHAIN_DATA,
        repaired: false,
      });
      expect(run.drifts[0].repairError).toContain('unrecognised status');
    });

    it('rethrows unexpected errors', async () => {
      escrowService.findAll.mockResolvedValue([makeEscrow()]);
      chainClient.getEscrow.mockRejectedValue(new Error('network'));
      await expect(service.reconcile()).rejects.toThrow('network');
    });
  });
});
