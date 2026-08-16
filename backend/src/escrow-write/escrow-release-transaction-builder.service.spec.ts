import { Account, Keypair, Transaction } from '@stellar/stellar-sdk';
import { EscrowReleaseTransactionBuilderService } from './escrow-release-transaction-builder.service';
import { STELLAR_CONFIG } from '../stellar/stellar.config';

const TEST_CONTRACT_ID = 'CBNXX7I4MGHZO3YAKXJIJNR5TTNSP6R2JAXMA44FS47JSTYAW7LIR4CS';

function makeRpcServer() {
  return {
    getAccount: jest.fn(),
    prepareTransaction: jest.fn(),
  };
}

describe('EscrowReleaseTransactionBuilderService', () => {
  describe('not configured (no contractId)', () => {
    let rpcServer: ReturnType<typeof makeRpcServer>;
    let service: EscrowReleaseTransactionBuilderService;

    beforeEach(() => {
      rpcServer = makeRpcServer();
      service = new EscrowReleaseTransactionBuilderService(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rpcServer as any,
        { ...STELLAR_CONFIG, contractId: '' },
      );
    });

    it('reports not configured', () => {
      expect(service.isConfigured).toBe(false);
    });

    it('refuses to build a transaction against no contract, without touching the RPC server', async () => {
      await expect(service.buildRelease('esc-1', Keypair.random().publicKey())).rejects.toThrow(
        'TRUSTFLOW_CONTRACT_ID is not set',
      );
      expect(rpcServer.getAccount).not.toHaveBeenCalled();
    });
  });

  describe('configured (contractId set)', () => {
    let rpcServer: ReturnType<typeof makeRpcServer>;
    let service: EscrowReleaseTransactionBuilderService;

    beforeEach(() => {
      rpcServer = makeRpcServer();
      service = new EscrowReleaseTransactionBuilderService(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rpcServer as any,
        { ...STELLAR_CONFIG, contractId: TEST_CONTRACT_ID },
      );
    });

    it('reports configured', () => {
      expect(service.isConfigured).toBe(true);
    });

    it('builds an unsigned release transaction via the invoking account and returns its XDR', async () => {
      const sourceKeypair = Keypair.random();
      const sourceAccount = new Account(sourceKeypair.publicKey(), '100');
      rpcServer.getAccount.mockResolvedValue(sourceAccount);

      let preparedFrom: Transaction | undefined;
      rpcServer.prepareTransaction.mockImplementation(async (tx: Transaction) => {
        preparedFrom = tx;
        return tx;
      });

      const result = await service.buildRelease('esc-1', sourceKeypair.publicKey());

      expect(rpcServer.getAccount).toHaveBeenCalledWith(sourceKeypair.publicKey());
      expect(preparedFrom?.operations).toHaveLength(1);
      expect(preparedFrom?.operations[0].type).toBe('invokeHostFunction');

      expect(result).toEqual({
        xdr: expect.any(String),
        network: STELLAR_CONFIG.network,
        networkPassphrase: STELLAR_CONFIG.networkPassphrase,
        contractId: TEST_CONTRACT_ID,
        sourceAccount: sourceKeypair.publicKey(),
      });
    });

    it('propagates RPC errors instead of swallowing them', async () => {
      rpcServer.getAccount.mockRejectedValue(new Error('account not found'));

      await expect(service.buildRelease('esc-1', Keypair.random().publicKey())).rejects.toThrow(
        'account not found',
      );
    });
  });
});
