import { Test, TestingModule } from '@nestjs/testing';
import { AdminService } from './admin.service';
import { EscrowService } from '../escrow/escrow.service';
import { GigService } from '../gig/gig.service';
import { DisputeSagaService } from '../dispute/dispute-saga.service';
import { DisputeStep, DisputeVerdict } from '../dispute/dispute.types';
import { ReputationService } from '../reputation/reputation.service';
import { MigrationRunnerService } from '../migration/migration-runner.service';
import { MigrationStatus } from '../migration/migration.types';
import { EscrowReconciliationService } from '../escrow-reconciliation/escrow-reconciliation.service';
import { GigStatus } from '../gig/gig.entity';

describe('AdminService', () => {
  let service: AdminService;

  const mockEscrowService = { findAll: jest.fn() };
  const mockGigService = { findAll: jest.fn() };
  const mockDisputeSagaService = { findAll: jest.fn() };
  const mockReputationService = { getTrackedAddressCount: jest.fn(), getLeaderboard: jest.fn() };
  const mockMigrationRunnerService = { findAll: jest.fn() };
  const mockReconciliationService = { findAll: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: EscrowService, useValue: mockEscrowService },
        { provide: GigService, useValue: mockGigService },
        { provide: DisputeSagaService, useValue: mockDisputeSagaService },
        { provide: ReputationService, useValue: mockReputationService },
        { provide: MigrationRunnerService, useValue: mockMigrationRunnerService },
        { provide: EscrowReconciliationService, useValue: mockReconciliationService },
      ],
    }).compile();

    service = module.get<AdminService>(AdminService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getEscrowAnalytics', () => {
    it('tallies escrows by status and sums their value', async () => {
      mockEscrowService.findAll.mockResolvedValue([
        { status: 'active', amountXLM: '100' },
        { status: 'active', amountXLM: '50' },
        { status: 'released', amountXLM: '25' },
        { status: 'disputed', amountXLM: 'not-a-number' },
      ]);

      const result = await service.getEscrowAnalytics();

      expect(result).toEqual({
        total: 4,
        byStatus: { active: 2, released: 1, disputed: 1 },
        totalValueXLM: 175,
      });
    });

    it('handles no escrows', async () => {
      mockEscrowService.findAll.mockResolvedValue([]);
      expect(await service.getEscrowAnalytics()).toEqual({
        total: 0,
        byStatus: {},
        totalValueXLM: 0,
      });
    });
  });

  describe('getGigAnalytics', () => {
    it('tallies gigs by status', async () => {
      mockGigService.findAll.mockResolvedValue([
        { status: GigStatus.OPEN },
        { status: GigStatus.OPEN },
        { status: GigStatus.EXPIRED },
      ]);

      expect(await service.getGigAnalytics()).toEqual({
        total: 3,
        byStatus: { [GigStatus.OPEN]: 2, [GigStatus.EXPIRED]: 1 },
      });
    });
  });

  describe('getDisputeAnalytics', () => {
    it('tallies by step and only counts a verdict once one is reached', () => {
      mockDisputeSagaService.findAll.mockReturnValue([
        { currentStep: DisputeStep.VOTING, verdict: undefined },
        { currentStep: DisputeStep.COMPLETED, verdict: DisputeVerdict.BENEFICIARY_WINS },
        { currentStep: DisputeStep.COMPLETED, verdict: DisputeVerdict.BENEFICIARY_WINS },
      ]);

      expect(service.getDisputeAnalytics()).toEqual({
        total: 3,
        byStep: { [DisputeStep.VOTING]: 1, [DisputeStep.COMPLETED]: 2 },
        byVerdict: { [DisputeVerdict.BENEFICIARY_WINS]: 2 },
      });
    });
  });

  describe('getReputationAnalytics', () => {
    it('delegates to the reputation service with the overview top-N limit', () => {
      mockReputationService.getTrackedAddressCount.mockReturnValue(42);
      mockReputationService.getLeaderboard.mockReturnValue([{ address: 'GABC', score: 10 }]);

      const result = service.getReputationAnalytics();

      expect(mockReputationService.getLeaderboard).toHaveBeenCalledWith(5);
      expect(result).toEqual({
        trackedAddresses: 42,
        topAddresses: [{ address: 'GABC', score: 10 }],
      });
    });
  });

  describe('getMigrationAnalytics', () => {
    it('tallies runs by status', () => {
      mockMigrationRunnerService.findAll.mockReturnValue([
        { status: MigrationStatus.COMPLETED },
        { status: MigrationStatus.FAILED },
      ]);

      expect(service.getMigrationAnalytics()).toEqual({
        total: 2,
        byStatus: { [MigrationStatus.COMPLETED]: 1, [MigrationStatus.FAILED]: 1 },
      });
    });
  });

  describe('getReconciliationAnalytics', () => {
    it('sums drift counts and reports the most recent completion time', () => {
      mockReconciliationService.findAll.mockReturnValue([
        { completedAt: '2026-01-01T00:00:00.000Z', driftCount: 2, repairedCount: 2 },
        { completedAt: '2026-02-01T00:00:00.000Z', driftCount: 1, repairedCount: 0 },
      ]);

      expect(service.getReconciliationAnalytics()).toEqual({
        totalRuns: 2,
        totalDriftsDetected: 3,
        totalDriftsRepaired: 2,
        lastRunAt: '2026-02-01T00:00:00.000Z',
      });
    });

    it('reports undefined lastRunAt when no runs exist', () => {
      mockReconciliationService.findAll.mockReturnValue([]);
      expect(service.getReconciliationAnalytics().lastRunAt).toBeUndefined();
    });
  });

  describe('getOverview', () => {
    it('assembles every section plus a generatedAt timestamp', async () => {
      mockEscrowService.findAll.mockResolvedValue([]);
      mockGigService.findAll.mockResolvedValue([]);
      mockDisputeSagaService.findAll.mockReturnValue([]);
      mockReputationService.getTrackedAddressCount.mockReturnValue(0);
      mockReputationService.getLeaderboard.mockReturnValue([]);
      mockMigrationRunnerService.findAll.mockReturnValue([]);
      mockReconciliationService.findAll.mockReturnValue([]);

      const result = await service.getOverview();

      expect(result.generatedAt).toEqual(expect.any(String));
      expect(new Date(result.generatedAt).toString()).not.toEqual('Invalid Date');
      expect(result).toEqual(
        expect.objectContaining({
          escrows: { total: 0, byStatus: {}, totalValueXLM: 0 },
          gigs: { total: 0, byStatus: {} },
          disputes: { total: 0, byStep: {}, byVerdict: {} },
          reputation: { trackedAddresses: 0, topAddresses: [] },
          migrations: { total: 0, byStatus: {} },
          reconciliation: {
            totalRuns: 0,
            totalDriftsDetected: 0,
            totalDriftsRepaired: 0,
            lastRunAt: undefined,
          },
        }),
      );
    });
  });
});
