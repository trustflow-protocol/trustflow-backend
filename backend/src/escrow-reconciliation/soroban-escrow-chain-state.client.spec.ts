import { ChainEscrowRecord } from './escrow-reconciliation.types';

describe('SorobanEscrowChainStateClient', () => {
  const originalContractId = process.env.TRUSTFLOW_CONTRACT_ID;

  afterEach(() => {
    if (originalContractId === undefined) delete process.env.TRUSTFLOW_CONTRACT_ID;
    else process.env.TRUSTFLOW_CONTRACT_ID = originalContractId;
    jest.resetModules();
  });

  describe('simulated mode (no TRUSTFLOW_CONTRACT_ID configured)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let client: any;

    beforeEach(() => {
      delete process.env.TRUSTFLOW_CONTRACT_ID;
      jest.resetModules();
      // The client reads getStellarConfig() in its constructor, which requires
      // validateEnv() to have run first — normally done once in main.ts. jest.resetModules()
      // above wipes env.config.ts's cached validation, so it must be re-run against this
      // fresh module registry before requiring the client.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('../config/env.config').validateEnv();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('./soroban-escrow-chain-state.client');
      client = new mod.SorobanEscrowChainStateClient();
    });

    it('reports not configured', () => {
      expect(client.isConfigured).toBe(false);
    });

    it('returns undefined for an unseeded escrow, without touching the RPC server', async () => {
      await expect(client.getEscrow('esc-unknown')).resolves.toBeUndefined();
    });

    it('returns a seeded record', async () => {
      const record: ChainEscrowRecord = {
        contractEscrowId: 'esc-1',
        depositor: `G${'A'.repeat(55)}`,
        beneficiary: `G${'B'.repeat(55)}`,
        amountXLM: '100',
        status: 'active',
      };
      client.seedSimulated(record);

      await expect(client.getEscrow('esc-1')).resolves.toEqual(record);
    });
  });

  describe('configured mode (TRUSTFLOW_CONTRACT_ID set)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let client: any;

    beforeEach(() => {
      process.env.TRUSTFLOW_CONTRACT_ID =
        'CTESTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
      jest.resetModules();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('../config/env.config').validateEnv();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('./soroban-escrow-chain-state.client');
      client = new mod.SorobanEscrowChainStateClient();
    });

    it('reports configured', () => {
      expect(client.isConfigured).toBe(true);
    });

    it('decodes contract data into a ChainEscrowRecord', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { nativeToScVal } = require('@stellar/stellar-sdk');
      const nativeVal = nativeToScVal(
        {
          depositor: `G${'A'.repeat(55)}`,
          beneficiary: `G${'B'.repeat(55)}`,
          amount: '250',
          status: 'released',
        },
        { type: 'instance' },
      );
      const fakeEntry = { val: { contractData: () => ({ val: () => nativeVal }) } };
      jest.spyOn(client.rpcServer, 'getContractData').mockResolvedValue(fakeEntry);

      await expect(client.getEscrow('esc-2')).resolves.toEqual({
        contractEscrowId: 'esc-2',
        depositor: `G${'A'.repeat(55)}`,
        beneficiary: `G${'B'.repeat(55)}`,
        amountXLM: '250',
        status: 'released',
      });
    });

    it('rejects an unknown status instead of returning it', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { nativeToScVal } = require('@stellar/stellar-sdk');
      const nativeVal = nativeToScVal(
        {
          depositor: `G${'A'.repeat(55)}`,
          beneficiary: `G${'B'.repeat(55)}`,
          amount: '250',
          status: 'Bogus',
        },
        { type: 'instance' },
      );
      const fakeEntry = { val: { contractData: () => ({ val: () => nativeVal }) } };
      jest.spyOn(client.rpcServer, 'getContractData').mockResolvedValue(fakeEntry);

      await expect(client.getEscrow('esc-bad')).rejects.toThrow('unrecognised status');
    });

    it('rejects a record with a missing field rather than emitting "undefined"', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { nativeToScVal } = require('@stellar/stellar-sdk');
      const nativeVal = nativeToScVal(
        { depositor: `G${'A'.repeat(55)}`, amount: '1', status: 'active' },
        {
          type: 'instance',
        },
      );
      const fakeEntry = { val: { contractData: () => ({ val: () => nativeVal }) } };
      jest.spyOn(client.rpcServer, 'getContractData').mockResolvedValue(fakeEntry);

      await expect(client.getEscrow('esc-bad')).rejects.toThrow('beneficiary');
    });

    it('returns undefined when the contract holds no entry for the escrow', async () => {
      jest
        .spyOn(client.rpcServer, 'getContractData')
        .mockRejectedValue({ message: 'Contract data not found. Contract: C..., Key: ...' });

      await expect(client.getEscrow('esc-missing')).resolves.toBeUndefined();
    });

    it('rethrows unexpected RPC errors', async () => {
      jest
        .spyOn(client.rpcServer, 'getContractData')
        .mockRejectedValue(new Error('network timeout'));

      await expect(client.getEscrow('esc-err')).rejects.toThrow('network timeout');
    });
  });
});
