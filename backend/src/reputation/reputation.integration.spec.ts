import { Test, TestingModule } from '@nestjs/testing';
import { EscrowModule } from '../escrow/escrow.module';
import { EscrowController } from '../escrow/escrow.controller';
import { EscrowService } from '../escrow/escrow.service';
import { DisputeModule } from '../dispute/dispute.module';
import { DisputeSagaService } from '../dispute/dispute-saga.service';
import { ReputationModule } from './reputation.module';
import { ReputationController } from './reputation.controller';

const JURORS = [
  'GJUROR1111111111111111111111111111111111111111111111111111',
  'GJUROR2222222222222222222222222222222222222222222222222222',
  'GJUROR3333333333333333333333333333333333333333333333333333',
];

/**
 * Wires EscrowModule, DisputeModule, and ReputationModule together exactly as AppModule
 * assembles them in production — no mocked services — to catch any miswiring between the
 * modules that unit tests (which mock each module's collaborators) wouldn't surface.
 */
describe('Reputation engine integration', () => {
  let module: TestingModule;
  let escrowController: EscrowController;
  let escrowService: EscrowService;
  let disputeSagaService: DisputeSagaService;
  let reputationController: ReputationController;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [EscrowModule, DisputeModule, ReputationModule],
    }).compile();

    escrowController = module.get(EscrowController);
    escrowService = module.get(EscrowService);
    disputeSagaService = module.get(DisputeSagaService);
    reputationController = module.get(ReputationController);
  });

  afterEach(async () => {
    await module.close();
  });

  it('records a completion through EscrowController.release() and reflects it in GET /reputation/:address', async () => {
    const depositor = 'GDEPOSITOR11111111111111111111111111111111111111111INTEG';
    const beneficiary = 'GBENEFICIARY111111111111111111111111111111111111111INTEG';

    const escrow = await escrowService.create(depositor, beneficiary, '100');
    await escrowController.release(escrow.id);

    const depositorScore = reputationController.getScore(depositor);
    const beneficiaryScore = reputationController.getScore(beneficiary);

    expect(depositorScore.score).toBeGreaterThan(0);
    expect(depositorScore.eventCount).toBe(1);
    expect(beneficiaryScore.score).toBeGreaterThan(0);
    expect(beneficiaryScore.eventCount).toBe(1);
  });

  it('does not record a completion for an escrow that ends up disputed', async () => {
    const depositor = 'GDEPOSITOR22222222222222222222222222222222222222222INTEG';
    const beneficiary = 'GBENEFICIARY222222222222222222222222222222222222222INTEG';

    const escrow = await escrowService.create(depositor, beneficiary, '100');
    await escrowController.raiseDispute(escrow.id, { reason: 'not delivered' });

    expect(reputationController.getScore(depositor).eventCount).toBe(0);
    expect(reputationController.getScore(beneficiary).eventCount).toBe(0);
  });

  it('records a won/lost outcome through the full dispute saga once the verdict payout executes', async () => {
    const depositor = 'GDEPOSITOR33333333333333333333333333333333333333333INTEG';
    const beneficiary = 'GBENEFICIARY333333333333333333333333333333333333333INTEG';

    const escrow = await escrowService.create(depositor, beneficiary, '100');

    const saga = await disputeSagaService.escalate(escrow.id, {
      initiator: depositor,
      reason: 'Work was not delivered as agreed',
    });
    await disputeSagaService.assignJurors(saga.sagaId, { jurors: JURORS });
    // Unanimous vote for the depositor -> DEPOSITOR_WINS verdict.
    await disputeSagaService.castVote(saga.sagaId, { jurorAddress: JURORS[0], vote: 'depositor' });
    await disputeSagaService.castVote(saga.sagaId, { jurorAddress: JURORS[1], vote: 'depositor' });
    await disputeSagaService.castVote(saga.sagaId, { jurorAddress: JURORS[2], vote: 'depositor' });
    await disputeSagaService.executePayout(saga.sagaId, {});

    const depositorScore = reputationController.getScore(depositor);
    const beneficiaryScore = reputationController.getScore(beneficiary);

    expect(depositorScore.score).toBeGreaterThan(0);
    expect(depositorScore.recentEvents[0]).toMatchObject({ type: 'dispute_won' });
    expect(beneficiaryScore.score).toBeLessThan(0);
    expect(beneficiaryScore.recentEvents[0]).toMatchObject({ type: 'dispute_lost' });
  });

  it('ranks the two flows correctly on GET /reputation/leaderboard', async () => {
    const winner = 'GWINNER11111111111111111111111111111111111111111111INTEG';
    const loser = 'GLOSER111111111111111111111111111111111111111111111INTEG';

    const escrow = await escrowService.create(winner, loser, '100');
    const saga = await disputeSagaService.escalate(escrow.id, {
      initiator: winner,
      reason: 'Work was not delivered as agreed',
    });
    await disputeSagaService.assignJurors(saga.sagaId, { jurors: JURORS });
    await disputeSagaService.castVote(saga.sagaId, { jurorAddress: JURORS[0], vote: 'depositor' });
    await disputeSagaService.castVote(saga.sagaId, { jurorAddress: JURORS[1], vote: 'depositor' });
    await disputeSagaService.castVote(saga.sagaId, { jurorAddress: JURORS[2], vote: 'depositor' });
    await disputeSagaService.executePayout(saga.sagaId, {});

    const leaderboard = reputationController.getLeaderboard(undefined);
    const winnerRank = leaderboard.findIndex(v => v.address === winner);
    const loserRank = leaderboard.findIndex(v => v.address === loser);

    expect(winnerRank).toBeGreaterThanOrEqual(0);
    expect(loserRank).toBeGreaterThanOrEqual(0);
    expect(winnerRank).toBeLessThan(loserRank);
  });
});
