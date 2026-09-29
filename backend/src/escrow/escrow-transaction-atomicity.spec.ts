import { Test, TestingModule } from '@nestjs/testing';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  EscrowService,
  ESCROW_EVENTS,
  ESCROW_TRANSACTION_INCONSISTENT_METRIC,
} from './escrow.service';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { MetricsService } from '../monitoring/metrics.service';
import { makeFakeRedisClient } from '../testing/fake-redis-client';

/**
 * Regression coverage for the "partial failures leave inconsistent state" class of bug.
 *
 * Redis `MULTI`/`EXEC` does not roll back the commands that already ran. A service that treats
 * a per-command failure as a normal error and falls back to an in-memory store therefore
 * reports success for a write that is only half present in the durable store — the state that
 * shows up later as "the escrow exists but the index does not".
 *
 * These tests assert the two properties that matter:
 *   1. a non-atomic write never returns success, and
 *   2. it never falls back to memory, because memory cannot be reconciled with Redis.
 */

const DEPOSITOR = `G${'A'.repeat(55)}`;
const BENEFICIARY = `G${'B'.repeat(55)}`;
const AMOUNT = '100';

describe('EscrowService transaction atomicity', () => {
  let service: EscrowService;
  let metrics: { increment: jest.Mock };

  const build = async (redis: ReturnType<typeof makeFakeRedisClient> | null) => {
    metrics = { increment: jest.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        EscrowService,
        { provide: REDIS_CLIENT, useValue: redis },
        { provide: MetricsService, useValue: metrics },
      ],
    }).compile();
    service = moduleRef.get(EscrowService);
    Logger.overrideLogger(false);
    return service;
  };

  it('surfaces a partially applied MULTI instead of reporting success', async () => {
    const redis = makeFakeRedisClient();
    // The entity SET succeeds; the second queued command fails.
    redis.mockNextExecResult(() =>
      Promise.resolve([
        [null, 'OK'],
        [new Error('WRONGTYPE'), null],
      ]),
    );
    await build(redis);

    await expect(service.create(DEPOSITOR, BENEFICIARY, AMOUNT)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(metrics.increment).toHaveBeenCalledWith(ESCROW_TRANSACTION_INCONSISTENT_METRIC, {
      operation: 'create',
      reason: 'command-failed',
    });
  });

  it('surfaces a non-atomic status transition rather than leaving a half-written escrow', async () => {
    const redis = makeFakeRedisClient();
    // Seed an escrow so `release` has something to transition.
    const seed = {
      id: 'esc-1',
      depositor: DEPOSITOR,
      beneficiary: BENEFICIARY,
      amountXLM: AMOUNT,
      status: 'disputed',
      createdAt: new Date().toISOString(),
    };
    redis.get.mockResolvedValue(JSON.stringify(seed));
    redis.mockNextExecResult(() =>
      Promise.resolve([
        [null, 'OK'],
        [new Error('OOM'), null],
      ]),
    );
    await build(redis);

    await expect(service.release('esc-1')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('surfaces a non-atomic chain-state reconciliation write', async () => {
    const redis = makeFakeRedisClient();
    const seed = {
      id: 'esc-1',
      depositor: DEPOSITOR,
      beneficiary: BENEFICIARY,
      amountXLM: AMOUNT,
      status: 'active',
      createdAt: new Date().toISOString(),
    };
    redis.get.mockResolvedValue(JSON.stringify(seed));
    redis.mockNextExecResult(() =>
      Promise.resolve([
        [null, 'OK'],
        [new Error('OOM'), null],
      ]),
    );
    await build(redis);

    // applyChainState is the reconciler's repair path — a silently "successful" repair here
    // means the chain/DB drift is recorded as fixed while it is not.
    await expect(service.applyChainState('esc-1', { status: 'released' })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('surfaces a non-atomic linkContractEscrowId', async () => {
    const redis = makeFakeRedisClient();
    const seed = {
      id: 'esc-1',
      depositor: DEPOSITOR,
      beneficiary: BENEFICIARY,
      amountXLM: AMOUNT,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    redis.get.mockResolvedValue(JSON.stringify(seed));
    redis.mockNextExecResult(() =>
      Promise.resolve([
        [null, 'OK'],
        [new Error('OOM'), null],
      ]),
    );
    await build(redis);

    await expect(service.linkContractEscrowId('esc-1', 'chain-1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('exposes a distinct metric for integrity failures so they can be alerted on', () => {
    expect(ESCROW_TRANSACTION_INCONSISTENT_METRIC).toBe('escrow_transaction_inconsistent_total');
    expect(ESCROW_EVENTS.ESCROW_RELEASED).toBeTruthy();
  });
});
