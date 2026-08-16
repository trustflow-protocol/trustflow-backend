import { Account, Keypair, Transaction } from '@stellar/stellar-sdk';

const TEST_CONTRACT_ID = 'CBNXX7I4MGHZO3YAKXJIJNR5TTNSP6R2JAXMA44FS47JSTYAW7LIR4CS';

describe('EscrowReleaseTransactionBuilderService', () => {
  const originalContractId = process.env.TRUSTFLOW_CONTRACT_ID;

  afterEach(() => {
    if (originalContractId === undefined) delete process.env.TRUSTFLOW_CONTRACT_ID;
    else process.env.TRUSTFLOW_CONTRACT_ID = originalContractId;
    jest.resetModules();
  });

  describe('not configured (no TRUSTFLOW_CONTRACT_ID)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let service: any;

    beforeEach(() => {
      delete process.env.TRUSTFLOW_CONTRACT_ID;
      jest.resetModules();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('./escrow-release-transaction-builder.service');
      service = new mod.EscrowReleaseTransactionBuilderService();
    });

    it('reports not configured', () => {
      expect(service.isConfigured).toBe(false);
    });

    it('refuses to build a transaction against no contract', async () => {
      await expect(service.buildRelease('esc-1', Keypair.random().publicKey())).rejects.toThrow(
        'TRUSTFLOW_CONTRACT_ID is not set',
      );
    });
  });

  describe('configured (TRUSTFLOW_CONTRACT_ID set)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let service: any;

    beforeEach(() => {
      process.env.TRUSTFLOW_CONTRACT_ID = TEST_CONTRACT_ID;
      jest.resetModules();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('./escrow-release-transaction-builder.service');
      service = new mod.EscrowReleaseTransactionBuilderService();
    });

    it('reports configured', () => {
      expect(service.isConfigured).toBe(true);
    });

    it('builds an unsigned release transaction via the invoking account and returns its XDR', async () => {
      const sourceKeypair = Keypair.random();
      const sourceAccount = new Account(sourceKeypair.publicKey(), '100');
      jest.spyOn(service.rpcServer, 'getAccount').mockResolvedValue(sourceAccount);

      let preparedFrom: Transaction | undefined;
      jest
        .spyOn(service.rpcServer, 'prepareTransaction')
        .mockImplementation(async (tx: Transaction) => {
          preparedFrom = tx;
          return tx;
        });

      const result = await service.buildRelease('esc-1', sourceKeypair.publicKey());

      expect(service.rpcServer.getAccount).toHaveBeenCalledWith(sourceKeypair.publicKey());
      expect(preparedFrom?.operations).toHaveLength(1);
      expect(preparedFrom?.operations[0].type).toBe('invokeHostFunction');

      expect(result).toEqual({
        xdr: expect.any(String),
        network: 'TESTNET',
        networkPassphrase: 'Test SDF Network ; September 2015',
        contractId: TEST_CONTRACT_ID,
        sourceAccount: sourceKeypair.publicKey(),
      });
    });

    it('propagates RPC errors instead of swallowing them', async () => {
      jest.spyOn(service.rpcServer, 'getAccount').mockRejectedValue(new Error('account not found'));

      await expect(service.buildRelease('esc-1', Keypair.random().publicKey())).rejects.toThrow(
        'account not found',
      );
    });
  });
});
