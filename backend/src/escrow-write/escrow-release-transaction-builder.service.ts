import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  rpc as SorobanRpc,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
} from '@stellar/stellar-sdk';
import { STELLAR_CONFIG } from '../stellar/stellar.config';

export const SOROBAN_RPC_SERVER = 'SOROBAN_RPC_SERVER';
export const ESCROW_WRITE_STELLAR_CONFIG = 'ESCROW_WRITE_STELLAR_CONFIG';

/**
 * Assumed entrypoint for the non-disputed release call: a single string argument, the
 * contract's own escrow id. Not yet verified against a real contract — see the #180 spike
 * write-up (backend/ESCROW_WRITE_PATH_SPIKE.md) for why. Update this if the confirmed
 * contract signature turns out to differ.
 */
const RELEASE_ENTRYPOINT = 'release';

export interface UnsignedReleaseTransaction {
  xdr: string;
  network: string;
  networkPassphrase: string;
  contractId: string;
  sourceAccount: string;
}

/**
 * Builds (but never signs or submits) the Soroban invocation that releases an escrow
 * on-chain — the write-path prototype for the #180 spike.
 *
 * The backend holds no signing keys anywhere in this codebase (there is no KMS/HSM/secrets
 * manager integration), so per the spike's recommendation this stays that way: the caller's
 * own wallet signs the returned XDR and submits it directly to Soroban RPC. The result then
 * flows back into EscrowService the same way any other on-chain change already does — through
 * event-ingestion — so nothing downstream of this needs to change.
 */
@Injectable()
export class EscrowReleaseTransactionBuilderService {
  private readonly logger = new Logger(EscrowReleaseTransactionBuilderService.name);

  constructor(
    @Inject(SOROBAN_RPC_SERVER) private readonly rpcServer: SorobanRpc.Server,
    @Inject(ESCROW_WRITE_STELLAR_CONFIG) private readonly config: typeof STELLAR_CONFIG,
  ) {}

  get isConfigured(): boolean {
    return Boolean(this.config.contractId);
  }

  async buildRelease(
    contractEscrowId: string,
    sourceAccount: string,
  ): Promise<UnsignedReleaseTransaction> {
    if (!this.isConfigured) {
      throw new ServiceUnavailableException(
        'TRUSTFLOW_CONTRACT_ID is not set; cannot build a release transaction with no contract to call.',
      );
    }

    const account = await this.rpcServer.getAccount(sourceAccount);
    const contract = new Contract(this.config.contractId);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        contract.call(RELEASE_ENTRYPOINT, nativeToScVal(contractEscrowId, { type: 'string' })),
      )
      .setTimeout(60)
      .build();

    const prepared = await this.rpcServer.prepareTransaction(tx);

    this.logger.log(`Built unsigned release transaction for escrow ${contractEscrowId}`);

    return {
      xdr: prepared.toXDR(),
      network: this.config.network,
      networkPassphrase: this.config.networkPassphrase,
      contractId: this.config.contractId,
      sourceAccount,
    };
  }
}
