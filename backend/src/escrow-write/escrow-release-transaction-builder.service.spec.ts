import {
  Account,
  BASE_FEE,
  FeeBumpTransaction,
  Keypair,
  SorobanDataBuilder,
  Transaction,
  rpc as SorobanRpc,
  xdr,
} from '@stellar/stellar-sdk';
import {
  EscrowReleaseTransactionBuilderService,
  MAX_RELEASE_TX_VALIDITY_SECONDS,
  clampReleaseTxValidity,
} from './escrow-release-transaction-builder.service';
import { validateEnv } from '../config/env.config';
import { getStellarConfig } from '../stellar/stellar.config';

// getStellarConfig() reads validated env config — normally done once in main.ts.
validateEnv();

const TEST_CONTRACT_ID = 'CBNXX7I4MGHZO3YAKXJIJNR5TTNSP6R2JAXMA44FS47JSTYAW7LIR4CS';

function makeRpcServer() {
  return {
    getAccount: jest.fn(),
    simulateTransaction: jest.fn(),
    prepareTransaction: jest.fn(),
  };
}

/** A minimal *parsed* simulation response suitable for `assembleTransaction`. */
function makeSimulation(minResourceFee: string): SorobanRpc.Api.SimulateTransactionResponse {
  return {
    _parsed: true,
    latestLedger: 1,
    minResourceFee,
    transactionData: new SorobanDataBuilder(),
    cost: { cpuInsns: '0', memBytes: '0' },
    events: [],
    result: { auth: [], retval: xdr.ScVal.scvVoid() },
  } as unknown as SorobanRpc.Api.SimulateTransactionResponse;
}

describe('release transaction validity window', () => {
  it('keeps the configured default short', () => {
    expect(clampReleaseTxValidity(60)).toBe(60);
  });

  it('caps an oversized validity window so held XDRs cannot be replayed days later', () => {
    expect(clampReleaseTxValidity(60 * 60 * 24)).toBe(MAX_RELEASE_TX_VALIDITY_SECONDS);
    expect(clampReleaseTxValidity(Number.POSITIVE_INFINITY)).toBe(MAX_RELEASE_TX_VALIDITY_SECONDS);
  });

  it('never produces a zero or negative validity', () => {
    expect(clampReleaseTxValidity(0)).toBe(1);
    expect(clampReleaseTxValidity(-10)).toBe(1);
  });
});

describe('EscrowReleaseTransactionBuilderService', () => {
  describe('not configured (no contractId)', () => {
    let rpcServer: ReturnType<typeof makeRpcServer>;
    let service: EscrowReleaseTransactionBuilderService;

    beforeEach(() => {
      rpcServer = makeRpcServer();
      service = new EscrowReleaseTransactionBuilderService(
        rpcServer as unknown as SorobanRpc.Server,
        { ...getStellarConfig(), contractId: '' },
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
        rpcServer as unknown as SorobanRpc.Server,
        { ...getStellarConfig(), contractId: TEST_CONTRACT_ID },
      );
    });

    it('reports configured', () => {
      expect(service.isConfigured).toBe(true);
    });

    it('builds an unsigned release transaction via the invoking account and returns its XDR', async () => {
      const sourceKeypair = Keypair.random();
      const sourceAccount = new Account(sourceKeypair.publicKey(), '100');
      rpcServer.getAccount.mockResolvedValue(sourceAccount);
      rpcServer.simulateTransaction.mockResolvedValue(makeSimulation('1000'));

      const result = await service.buildRelease('esc-1', sourceKeypair.publicKey());

      expect(rpcServer.getAccount).toHaveBeenCalledWith(sourceKeypair.publicKey());
      expect(rpcServer.simulateTransaction).toHaveBeenCalledTimes(1);

      const built = new Transaction(result.xdr, getStellarConfig().networkPassphrase);
      expect(built.operations).toHaveLength(1);
      expect(built.operations[0].type).toBe('invokeHostFunction');

      const { xdr: txXdr, ...rest } = result;
      expect(typeof txXdr).toBe('string');
      expect(rest).toEqual({
        network: getStellarConfig().network,
        networkPassphrase: getStellarConfig().networkPassphrase,
        contractId: TEST_CONTRACT_ID,
        sourceAccount: sourceKeypair.publicKey(),
      });
    });

    it('uses the simulated minResourceFee plus a 10% margin instead of a flat base fee', async () => {
      const sourceKeypair = Keypair.random();
      rpcServer.getAccount.mockResolvedValue(new Account(sourceKeypair.publicKey(), '100'));
      rpcServer.simulateTransaction.mockResolvedValue(makeSimulation('1000'));

      const result = await service.buildRelease('esc-1', sourceKeypair.publicKey());
      const built = new Transaction(result.xdr, getStellarConfig().networkPassphrase);

      // 1000 stroops resource fee + 10% margin + 100 stroop classic base fee = 1200.
      expect(built.fee).toBe((BigInt(BASE_FEE) + 1100n).toString());
    });

    it('floors the fee at the classic base fee when simulation reports no resource fee', async () => {
      const sourceKeypair = Keypair.random();
      rpcServer.getAccount.mockResolvedValue(new Account(sourceKeypair.publicKey(), '100'));
      rpcServer.simulateTransaction.mockResolvedValue(makeSimulation('0'));

      const result = await service.buildRelease('esc-1', sourceKeypair.publicKey());
      const built = new Transaction(result.xdr, getStellarConfig().networkPassphrase);

      expect(built.fee).toBe(BASE_FEE);
    });

    it('propagates simulation errors instead of building an underfunded transaction', async () => {
      const sourceKeypair = Keypair.random();
      rpcServer.getAccount.mockResolvedValue(new Account(sourceKeypair.publicKey(), '100'));
      rpcServer.simulateTransaction.mockResolvedValue({
        _parsed: true,
        error: 'HostError: invalid invocation',
        events: [],
      });

      await expect(service.buildRelease('esc-1', sourceKeypair.publicKey())).rejects.toThrow(
        'Release simulation failed for escrow esc-1: HostError: invalid invocation',
      );
    });

    it('sets an explicit short maxTime timebound on the unsigned transaction', async () => {
      const sourceKeypair = Keypair.random();
      rpcServer.getAccount.mockResolvedValue(new Account(sourceKeypair.publicKey(), '100'));
      rpcServer.simulateTransaction.mockResolvedValue(makeSimulation('1000'));

      const before = Math.floor(Date.now() / 1000);
      const result = await service.buildRelease('esc-1', sourceKeypair.publicKey());
      const after = Math.floor(Date.now() / 1000);

      const built = new Transaction(result.xdr, getStellarConfig().networkPassphrase);
      const bounds = built.timeBounds;
      expect(bounds).toBeDefined();
      expect(Number(bounds!.minTime)).toBe(0);
      const maxTime = Number(bounds!.maxTime);
      expect(maxTime).toBeGreaterThanOrEqual(before);
      expect(maxTime).toBeLessThanOrEqual(after + MAX_RELEASE_TX_VALIDITY_SECONDS);
    });

    it('propagates RPC errors instead of swallowing them', async () => {
      rpcServer.getAccount.mockRejectedValue(new Error('account not found'));

      await expect(service.buildRelease('esc-1', Keypair.random().publicKey())).rejects.toThrow(
        'account not found',
      );
    });
  });

  describe('bumpFee', () => {
    let service: EscrowReleaseTransactionBuilderService;
    let rpcServer: ReturnType<typeof makeRpcServer>;

    beforeEach(() => {
      rpcServer = makeRpcServer();
      service = new EscrowReleaseTransactionBuilderService(
        rpcServer as unknown as SorobanRpc.Server,
        { ...getStellarConfig(), contractId: TEST_CONTRACT_ID },
      );
    });

    async function buildInnerXdr(): Promise<{ xdr: string; fee: string }> {
      const sourceKeypair = Keypair.random();
      rpcServer.getAccount.mockResolvedValue(new Account(sourceKeypair.publicKey(), '100'));
      rpcServer.simulateTransaction.mockResolvedValue(makeSimulation('1000'));
      const result = await service.buildRelease('esc-1', sourceKeypair.publicKey());
      return result;
    }

    it('returns a fee-bump envelope XDR when the new fee exceeds the inner fee', async () => {
      const inner = await buildInnerXdr();
      const innerTx = new Transaction(inner.xdr, getStellarConfig().networkPassphrase);
      const innerFee = BigInt(innerTx.fee);
      const newFee = (innerFee + 5000n).toString();
      const feeAccount = Keypair.random().publicKey();

      const result = service.bumpFee(inner.xdr, newFee, feeAccount);

      expect(result.network).toBe(getStellarConfig().network);
      expect(result.networkPassphrase).toBe(getStellarConfig().networkPassphrase);
      expect(result.feeAccount).toBe(feeAccount);
      expect(typeof result.xdr).toBe('string');
      expect(typeof result.innerTransactionHash).toBe('string');

      // The returned XDR must parse as a FeeBumpTransaction
      const feeBump = new FeeBumpTransaction(result.xdr, getStellarConfig().networkPassphrase);
      expect(feeBump.fee).toBe(newFee);
      expect(feeBump.feeSource).toBe(feeAccount);
    });

    it('rejects when the new fee is not greater than the inner transaction fee', async () => {
      const inner = await buildInnerXdr();
      const innerTx = new Transaction(inner.xdr, getStellarConfig().networkPassphrase);
      const sameFee = innerTx.fee;

      expect(() => service.bumpFee(inner.xdr, sameFee, Keypair.random().publicKey())).toThrow(
        'must be greater than the inner transaction fee',
      );
    });

    it('rejects when the inner XDR is not a valid transaction for this network', () => {
      expect(() =>
        service.bumpFee('not-valid-xdr', '9999', Keypair.random().publicKey()),
      ).toThrow('not a valid transaction envelope');
    });
  });
});
