import { Test, TestingModule } from '@nestjs/testing';
import { EscrowService } from './escrow.service';

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('EscrowService', () => {
  let service: EscrowService;

  const DEPOSITOR = 'GDEPOSITOR111111111111111111111111111111111111111111111';
  const BENEFICIARY = 'GBENEFICIARY1111111111111111111111111111111111111111111';
  const AMOUNT = '100';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [EscrowService],
    }).compile();

    service = module.get<EscrowService>(EscrowService);
  });

  describe('create', () => {
    it('generates unique IDs even when called concurrently in a tight loop', async () => {
      const numEscrows = 1000;
      const promises: Promise<import('./escrow.service').Escrow>[] = [];
      for (let i = 0; i < numEscrows; i++) {
        promises.push(service.create(`GDEP${i}`, `GBEN${i}`, '100'));
      }
      
      const escrows = await Promise.all(promises);
      const ids = new Set(escrows.map(e => e.id));
      
      expect(ids.size).toBe(numEscrows);
      
      // Verify UUID format (basic check)
      const sampleId = escrows[0].id;
      expect(sampleId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ─── create() ─────────────────────────────────────────────────────────────

  describe('create()', () => {
    it('returns a new escrow with status "pending"', async () => {
      const escrow = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);

      expect(escrow.id).toBeDefined();
      expect(escrow.depositor).toBe(DEPOSITOR);
      expect(escrow.beneficiary).toBe(BENEFICIARY);
      expect(escrow.amountXLM).toBe(AMOUNT);
      expect(escrow.status).toBe('pending');
      expect(escrow.createdAt).toBeDefined();
    });

    it('generates a unique id for each escrow', async () => {
      const a = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
      const b = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
      expect(a.id).not.toBe(b.id);
    });

    it('persists the escrow so it can be retrieved by findById()', async () => {
      const created = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
      const found = await service.findById(created.id);
      expect(found).toEqual(created);
    });

    it('does not set disputeReason or disputedAt on creation', async () => {
      const escrow = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
      expect(escrow.disputeReason).toBeUndefined();
      expect(escrow.disputedAt).toBeUndefined();
    });
  });

  // ─── findById() ───────────────────────────────────────────────────────────

  describe('findById()', () => {
    it('returns undefined for an unknown id (does not throw)', async () => {
      const result = await service.findById('esc-unknown');
      expect(result).toBeUndefined();
    });

    it('returns the escrow after it has been created', async () => {
      const created = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
      expect(await service.findById(created.id)).toEqual(created);
    });
  });

  // ─── findByDepositor() ────────────────────────────────────────────────────

  describe('findByDepositor()', () => {
    it('returns an empty array when no escrows exist for that depositor', async () => {
      expect(await service.findByDepositor(DEPOSITOR)).toEqual([]);
    });

    it('returns only escrows belonging to the given depositor', async () => {
      const OTHER = 'GOTHER111111111111111111111111111111111111111111111111111';
      const mine = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
      await service.create(OTHER, BENEFICIARY, AMOUNT);

      const results = await service.findByDepositor(DEPOSITOR);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(mine.id);
    });

    it('returns multiple escrows for the same depositor', async () => {
      await service.create(DEPOSITOR, BENEFICIARY, '50');
      await service.create(DEPOSITOR, BENEFICIARY, '75');

      const results = await service.findByDepositor(DEPOSITOR);
      expect(results).toHaveLength(2);
    });
  });

  describe('findByDepositor', () => {
    it('returns paginated results for a depositor', async () => {
      for (let i = 0; i < 5; i++) {
        await service.create('GDEP', 'GBEN', '100');
      }
      await service.create('GOTHER', 'GBEN', '200');

      const result = await service.findByDepositor('GDEP', 0, 3);

      expect(result.total).toBe(5);
      expect(result.data).toHaveLength(3);
    });

    it('returns empty data when offset exceeds total', async () => {
      await service.create('GDEP', 'GBEN', '100');

      const result = await service.findByDepositor('GDEP', 10, 20);

      expect(result.total).toBe(1);
      expect(result.data).toHaveLength(0);
    });

    it('returns empty data for unknown depositor', async () => {
      await service.create('GDEP', 'GBEN', '100');

      const result = await service.findByDepositor('GUNKNOWN', 0, 20);

      expect(result.total).toBe(0);
      expect(result.data).toHaveLength(0);
    });
  });

  describe('fund', () => {
    it('updates status to active for a pending escrow', async () => {
      const escrow = await service.create('GDEP', 'GBEN', '100');
      const updated = await service.fund(escrow.id);
      expect(updated.status).toBe('active');
  // ─── release() ────────────────────────────────────────────────────────────

  describe('release()', () => {
    it('sets status to "released"', async () => {
      const escrow = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
      const released = await service.release(escrow.id);
      expect(released.status).toBe('released');
    });

    it('releases an escrow regardless of its current status', async () => {
      const escrow = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
      // Fund it first (pending → active), then release.
      await service.fund(escrow.id);
      const released = await service.release(escrow.id);
      expect(released.status).toBe('released');
    });

    it('throws when the escrow id is unknown', async () => {
      await expect(service.release('esc-unknown')).rejects.toThrow('Escrow not found');
    });
  });

  // ─── raiseDispute() ───────────────────────────────────────────────────────

  describe('raiseDispute()', () => {
    it('transitions a "pending" escrow to "disputed" and records reason + timestamp', async () => {
      const escrow = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
      const disputed = await service.raiseDispute(escrow.id, 'Work not delivered');

      expect(disputed.status).toBe('disputed');
      expect(disputed.disputeReason).toBe('Work not delivered');
      expect(disputed.disputedAt).toBeDefined();
      expect(new Date(disputed.disputedAt!).toISOString()).toBe(disputed.disputedAt);
    });

    it('works without a reason argument', async () => {
      const escrow = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
      const disputed = await service.raiseDispute(escrow.id);

      expect(disputed.status).toBe('disputed');
      expect(disputed.disputeReason).toBeUndefined();
    });

    it('throws when the escrow is already released (guard: cannot dispute released)', async () => {
      const escrow = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
      await service.release(escrow.id);

      await expect(service.raiseDispute(escrow.id, 'too late')).rejects.toThrow(
        'Cannot dispute a released escrow',
      );
    });

    it('throws when the escrow is already disputed (guard: cannot double-dispute)', async () => {
      const escrow = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
      await service.raiseDispute(escrow.id, 'first dispute');

      await expect(service.raiseDispute(escrow.id, 'second dispute')).rejects.toThrow(
        'Escrow is already disputed',
      );
    });

    it('throws when the escrow id is unknown', async () => {
      await expect(service.raiseDispute('esc-unknown', 'reason')).rejects.toThrow(
        'Escrow not found',
      );
    });

    it('does not change status when raiseDispute throws', async () => {
      const escrow = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
      await service.release(escrow.id);

      try {
        await service.raiseDispute(escrow.id, 'after release');
      } catch {
        // expected
      }

      const reloaded = await service.findById(escrow.id);
      expect(reloaded?.status).toBe('released');
    });
  });

  // ─── fund() ───────────────────────────────────────────────────────────────

  describe('fund()', () => {
    it('transitions a "pending" escrow to "active"', async () => {
      const escrow = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
      const funded = await service.fund(escrow.id);
      expect(funded.status).toBe('active');
    });

    it('throws when trying to fund a non-pending escrow', async () => {
      const escrow = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
      await service.fund(escrow.id); // now active

      await expect(service.fund(escrow.id)).rejects.toThrow('Cannot fund escrow in status');
    });

    it('throws when the escrow id is unknown', async () => {
      await expect(service.fund('esc-unknown')).rejects.toThrow('Escrow not found');
    });
  });

  // ─── cancel() ─────────────────────────────────────────────────────────────

  describe('cancel()', () => {
    it('sets status to "cancelled"', async () => {
      const escrow = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
      const cancelled = await service.cancel(escrow.id);
      expect(cancelled.status).toBe('cancelled');
    });

    it('throws when the escrow id is unknown', async () => {
      await expect(service.cancel('esc-unknown')).rejects.toThrow('Escrow not found');
    });
  });

  // ─── split() ──────────────────────────────────────────────────────────────

  describe('split()', () => {
    it('sets status to "released" and records the splitPercentage', async () => {
      const escrow = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
      const result = await service.split(escrow.id, 60);

      expect(result.status).toBe('released');
      expect(result.splitPercentage).toBe(60);
    });

    it('throws when the escrow id is unknown', async () => {
      await expect(service.split('esc-unknown', 50)).rejects.toThrow('Escrow not found');
    });
  });

  // ─── applyChainState() ────────────────────────────────────────────────────

  describe('applyChainState()', () => {
    it('overwrites status regardless of guard rules', async () => {
      const escrow = await service.create(DEPOSITOR, BENEFICIARY, AMOUNT);
      await service.release(escrow.id); // status = released

      // applyChainState bypasses guards — it can set any status.
      const patched = await service.applyChainState(escrow.id, { status: 'disputed' });
      expect(patched.status).toBe('disputed');
    });

    it('updates amountXLM when provided', async () => {
      const escrow = await service.create(DEPOSITOR, BENEFICIARY, '100');
      const patched = await service.applyChainState(escrow.id, { amountXLM: '200' });
      expect(patched.amountXLM).toBe('200');
    });

    it('only applies the fields present in the patch', async () => {
      const escrow = await service.create(DEPOSITOR, BENEFICIARY, '100');
      await service.applyChainState(escrow.id, { amountXLM: '150' });

      const reloaded = await service.findById(escrow.id);
      expect(reloaded?.status).toBe('pending'); // unchanged
      expect(reloaded?.amountXLM).toBe('150');
    });

    it('throws when the escrow id is unknown', async () => {
      await expect(
        service.applyChainState('esc-unknown', { status: 'active' }),
      ).rejects.toThrow('Escrow not found');
    });
  });

  // ─── findAll() ────────────────────────────────────────────────────────────

  describe('findAll()', () => {
    it('returns an empty array when no escrows exist', async () => {
      expect(await service.findAll()).toEqual([]);
    });

    it('returns all created escrows', async () => {
      await service.create(DEPOSITOR, BENEFICIARY, '50');
      await service.create(DEPOSITOR, BENEFICIARY, '75');

      const all = await service.findAll();
      expect(all).toHaveLength(2);
    });
  });
});
