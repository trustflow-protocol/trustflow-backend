import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  rpc as SorobanRpc,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
} from '@stellar/stellar-sdk';
import { STELLAR_CONFIG } from '../stellar/stellar.config';

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
 *
 * The `release` entrypoint name and its single string-id argument are assumed, mirroring the
 * storage-key assumption already documented in SorobanEscrowChainStateClient: no contract
 * source lives in this repo to verify either against, and the sibling contract-repo spike
 * flags the non-disputed release entrypoint as not yet built. Once that entrypoint's real
 * name/signature is confirmed, only this file's addOperation call needs to change.
 */
@Injectable()
export class EscrowReleaseTransactionBuilderService {
  private readonly logger = new Logger(EscrowReleaseTransactionBuilderService.name);
  private readonly rpcServer: SorobanRpc.Server;

  constructor() {
    this.rpcServer = new SorobanRpc.Server(STELLAR_CONFIG.sorobanRpcUrl);
  }

  get isConfigured(): boolean {
    return Boolean(STELLAR_CONFIG.contractId);
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
    const contract = new Contract(STELLAR_CONFIG.contractId);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: STELLAR_CONFIG.networkPassphrase,
    })
      .addOperation(contract.call('release', nativeToScVal(contractEscrowId, { type: 'string' })))
      .setTimeout(60)
      .build();

    const prepared = await this.rpcServer.prepareTransaction(tx);

    this.logger.log(`Built unsigned release transaction for escrow ${contractEscrowId}`);

    return {
      xdr: prepared.toXDR(),
      network: STELLAR_CONFIG.network,
      networkPassphrase: STELLAR_CONFIG.networkPassphrase,
      contractId: STELLAR_CONFIG.contractId,
      sourceAccount,
    };
  }
}
