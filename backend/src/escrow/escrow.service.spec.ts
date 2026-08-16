import { EscrowService } from './escrow.service';

describe('EscrowService', () => {
  let service: EscrowService;

  beforeEach(() => {
    service = new EscrowService();
  });

  describe('findAll', () => {
    it('returns every tracked escrow', async () => {
      await service.create('GDEP1', 'GBEN1', '100');
      await service.create('GDEP2', 'GBEN2', '200');

      const all = await service.findAll();

      expect(all).toHaveLength(2);
    });

    it('returns an empty array when nothing is tracked', async () => {
      await expect(service.findAll()).resolves.toEqual([]);
    });
  });

  describe('linkContractEscrowId / findByContractEscrowId', () => {
    it('links a DB row to its on-chain id and finds it back by that id', async () => {
      const escrow = await service.create('GDEP', 'GBEN', '100');

      await service.linkContractEscrowId(escrow.id, 'esc-chain-1');

      await expect(service.findByContractEscrowId('esc-chain-1')).resolves.toMatchObject({
        id: escrow.id,
        contractEscrowId: 'esc-chain-1',
      });
    });

    it('returns undefined for an unlinked contract escrow id', async () => {
      await expect(service.findByContractEscrowId('esc-unknown')).resolves.toBeUndefined();
    });

    it('throws when linking a non-existent escrow', async () => {
      await expect(service.linkContractEscrowId('esc-missing', 'esc-chain-1')).rejects.toThrow(
        'Escrow not found',
      );
    });
  });

  describe('applyChainState', () => {
    it('overwrites status and amount directly, bypassing transition guards', async () => {
      const escrow = await service.create('GDEP', 'GBEN', '100');
      await service.release(escrow.id);

      // release() alone wouldn't allow moving a released escrow back to disputed —
      // applyChainState must, since the reconciler trusts chain over local guards.
      const updated = await service.applyChainState(escrow.id, {
        status: 'disputed',
        amountXLM: '150',
      });

      expect(updated.status).toBe('disputed');
      expect(updated.amountXLM).toBe('150');
    });

    it('only overwrites the fields present in the patch', async () => {
      const escrow = await service.create('GDEP', 'GBEN', '100');

      const updated = await service.applyChainState(escrow.id, { status: 'active' });

      expect(updated.status).toBe('active');
      expect(updated.amountXLM).toBe('100');
    });

    it('throws when the escrow does not exist', async () => {
      await expect(service.applyChainState('esc-missing', { status: 'active' })).rejects.toThrow(
        'Escrow not found',
      );
    });
  });

  describe('createFromChainState', () => {
    it('creates a DB row already linked to its contract escrow id', async () => {
      const escrow = await service.createFromChainState({
        contractEscrowId: 'esc-chain-9',
        depositor: 'GDEP',
        beneficiary: 'GBEN',
        amountXLM: '500',
        status: 'active',
      });

      expect(escrow.contractEscrowId).toBe('esc-chain-9');
      expect(escrow.status).toBe('active');
      await expect(service.findById(escrow.id)).resolves.toEqual(escrow);
    });
  });
});
