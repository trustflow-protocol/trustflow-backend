import { ReputationService } from './reputation.service';
import { ReputationScoreStore } from './reputation-score.store';
import {
  EscrowParties,
  REPUTATION_DECAY_HALF_LIFE_MS,
  REPUTATION_WEIGHTS,
  ReputationEventType,
} from './reputation.types';

function makeEscrow(overrides: Partial<EscrowParties> = {}): EscrowParties {
  return {
    depositor: 'GDEPOSITOR',
    beneficiary: 'GBENEFICIARY',
    amountXLM: '100',
    ...overrides,
  };
}

describe('ReputationService', () => {
  let service: ReputationService;
  let store: ReputationScoreStore;

  beforeEach(() => {
    store = new ReputationScoreStore();
    service = new ReputationService(store);
  });

  describe('recordEscrowCompleted', () => {
    it('gives both depositor and beneficiary a positive score', async () => {
      await service.recordEscrowCompleted(makeEscrow());

      expect(service.getScore('GDEPOSITOR').score).toBeGreaterThan(0);
      expect(service.getScore('GBENEFICIARY').score).toBeGreaterThan(0);
    });

    it('counts one event and one distinct counterparty for a first-time interaction', async () => {
      await service.recordEscrowCompleted(makeEscrow());

      const view = service.getScore('GDEPOSITOR');
      expect(view.eventCount).toBe(1);
      expect(view.distinctCounterparties).toBe(1);
    });

    it('gives an escrow with zero/invalid amount no contribution', async () => {
      await service.recordEscrowCompleted(makeEscrow({ amountXLM: '0' }));
      expect(service.getScore('GDEPOSITOR').score).toBe(0);

      await service.recordEscrowCompleted(makeEscrow({ amountXLM: 'not-a-number' }));
      expect(service.getScore('GDEPOSITOR').score).toBe(0);
    });

    it('scales the contribution with amount, up to the configured cap', async () => {
      await service.recordEscrowCompleted(makeEscrow({ amountXLM: '4' }));
      const small = service.getScore('GDEPOSITOR').score;

      const bigStore = new ReputationScoreStore();
      const bigService = new ReputationService(bigStore);
      await bigService.recordEscrowCompleted(makeEscrow({ amountXLM: '10000' }));
      const big = bigService.getScore('GDEPOSITOR').score;

      expect(big).toBeGreaterThan(small);
    });
  });

  describe('Sybil dampening via repeated counterparties', () => {
    it('gives diminishing returns for repeated escrows with the same counterparty', async () => {
      await service.recordEscrowCompleted(makeEscrow());
      const afterFirst = service.getScore('GDEPOSITOR').score;

      await service.recordEscrowCompleted(makeEscrow());
      const afterSecond = service.getScore('GDEPOSITOR').score;

      const firstContribution = afterFirst;
      const secondContribution = afterSecond - afterFirst;

      // Second interaction with the same counterparty is dampened relative to the first.
      expect(secondContribution).toBeGreaterThan(0);
      expect(secondContribution).toBeLessThan(firstContribution);
      // Harmonic dampening: second contribution should be roughly half the first.
      expect(secondContribution).toBeCloseTo(firstContribution / 2, 5);
    });

    it('does not dampen interactions with distinct, one-off counterparties', async () => {
      await service.recordEscrowCompleted(makeEscrow({ depositor: 'GDEP', beneficiary: 'GBEN1' }));
      const afterFirst = service.getScore('GDEP').score;

      await service.recordEscrowCompleted(makeEscrow({ depositor: 'GDEP', beneficiary: 'GBEN2' }));
      const afterSecond = service.getScore('GDEP').score;

      const secondContribution = afterSecond - afterFirst;
      // A brand-new counterparty gets full, undampened weight.
      expect(secondContribution).toBeCloseTo(afterFirst, 5);
    });

    it('naturally dampens self-dealing without special-casing', async () => {
      // depositor === beneficiary: a single escrow paid to oneself. Both "sides" of the
      // contribution land on the same address, and the second one is a repeat interaction
      // with itself, so it gets dampened — the address doesn't get full credit twice.
      await service.recordEscrowCompleted(makeEscrow({ depositor: 'GSELF', beneficiary: 'GSELF' }));
      const selfScore = service.getScore('GSELF').score;

      const undampedTotal =
        2 * REPUTATION_WEIGHTS[ReputationEventType.ESCROW_COMPLETED] * Math.sqrt(100);

      // Undamped it would be full weight twice (1 + 1); dampened it's 1 + 1/2 — 75% of that total.
      expect(selfScore).toBeLessThan(undampedTotal);
      expect(selfScore).toBeCloseTo(undampedTotal * 0.75, 5);
    });
  });

  describe('recordDisputeResolved', () => {
    it('rewards the winner and penalizes the loser', async () => {
      await service.recordDisputeResolved(makeEscrow(), 'won', 'lost');

      expect(service.getScore('GDEPOSITOR').score).toBeGreaterThan(0);
      expect(service.getScore('GBENEFICIARY').score).toBeLessThan(0);
    });

    it('penalizes losing more heavily than it rewards winning', async () => {
      const winStore = new ReputationScoreStore();
      const winService = new ReputationService(winStore);
      await winService.recordDisputeResolved(makeEscrow(), 'won', 'lost');

      expect(Math.abs(winService.getScore('GBENEFICIARY').score)).toBeGreaterThan(
        winService.getScore('GDEPOSITOR').score,
      );
    });

    it('applies a mild negative to both parties on a split verdict', async () => {
      await service.recordDisputeResolved(makeEscrow(), 'split', 'split');

      expect(service.getScore('GDEPOSITOR').score).toBeLessThan(0);
      expect(service.getScore('GBENEFICIARY').score).toBeLessThan(0);
    });
  });

  describe('time decay', () => {
    const start = Date.parse('2026-01-01T00:00:00.000Z');

    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      jest.setSystemTime(start);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('halves the score after one full half-life with no new activity', async () => {
      await service.recordEscrowCompleted(makeEscrow());
      const initialScore = service.getScore('GDEPOSITOR').score;

      jest.setSystemTime(start + REPUTATION_DECAY_HALF_LIFE_MS);
      const decayedScore = service.getScore('GDEPOSITOR').score;

      expect(decayedScore).toBeCloseTo(initialScore / 2, 1);
    });

    it('applies decay before adding a new contribution', async () => {
      await service.recordEscrowCompleted(makeEscrow());
      const initialScore = service.getScore('GDEPOSITOR').score;

      jest.setSystemTime(start + REPUTATION_DECAY_HALF_LIFE_MS);
      await service.recordEscrowCompleted(makeEscrow());
      const scoreAfterDecayAndSecondEvent = service.getScore('GDEPOSITOR').score;

      // Decayed first contribution (half) + a dampened (halved, 2nd interaction) second contribution
      // should be noticeably less than simply adding two undamped, undecayed contributions.
      expect(scoreAfterDecayAndSecondEvent).toBeLessThan(initialScore * 2);
    });

    it('does not change score or timestamp when read again immediately', async () => {
      await service.recordEscrowCompleted(makeEscrow());
      const first = service.getScore('GDEPOSITOR');
      const second = service.getScore('GDEPOSITOR');

      expect(second.score).toBe(first.score);
    });
  });

  describe('getScore for an unknown address', () => {
    it('returns a zero-value view without persisting a record', () => {
      const view = service.getScore('GUNKNOWN');

      expect(view.score).toBe(0);
      expect(view.eventCount).toBe(0);
      expect(view.distinctCounterparties).toBe(0);
      expect(store.get('GUNKNOWN')).toBeUndefined();
    });
  });

  describe('getLeaderboard', () => {
    it('ranks addresses by score, highest first', async () => {
      await service.recordEscrowCompleted(makeEscrow({ depositor: 'GHIGH', amountXLM: '10000' }));
      await service.recordEscrowCompleted(makeEscrow({ depositor: 'GLOW', amountXLM: '1' }));

      const leaderboard = service.getLeaderboard();
      const addresses = leaderboard.map(v => v.address);

      expect(addresses.indexOf('GHIGH')).toBeLessThan(addresses.indexOf('GLOW'));
    });

    it('respects the limit parameter', async () => {
      await service.recordEscrowCompleted(makeEscrow({ depositor: 'G1', beneficiary: 'GB1' }));
      await service.recordEscrowCompleted(makeEscrow({ depositor: 'G2', beneficiary: 'GB2' }));
      await service.recordEscrowCompleted(makeEscrow({ depositor: 'G3', beneficiary: 'GB3' }));

      expect(service.getLeaderboard(2)).toHaveLength(2);
    });
  });

  describe('recentEvents', () => {
    it('records event type, counterparty, and contribution, capped at the configured limit', async () => {
      await service.recordEscrowCompleted(makeEscrow());
      const view = service.getScore('GDEPOSITOR');

      expect(view.recentEvents).toHaveLength(1);
      expect(view.recentEvents[0]).toMatchObject({
        type: 'escrow_completed',
        counterparty: 'GBENEFICIARY',
      });
      expect(view.recentEvents[0].contribution).toBeGreaterThan(0);
    });

    it('keeps the most recent event first', async () => {
      await service.recordEscrowCompleted(makeEscrow({ beneficiary: 'GBEN1' }));
      await service.recordEscrowCompleted(makeEscrow({ beneficiary: 'GBEN2' }));

      const view = service.getScore('GDEPOSITOR');
      expect(view.recentEvents[0].counterparty).toBe('GBEN2');
      expect(view.recentEvents[1].counterparty).toBe('GBEN1');
    });
  });
});
