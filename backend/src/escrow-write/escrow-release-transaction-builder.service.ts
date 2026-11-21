import { BadRequestException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import {
  rpc as SorobanRpc,
  Contract,
  TransactionBuilder,
  Transaction,
  BASE_FEE,
  nativeToScVal,
} from '@stellar/stellar-sdk';
import { StellarConfig } from '../stellar/stellar.config';
import { config } from '../config/env.config';

export const SOROBAN_RPC_SERVER = 'SOROBAN_RPC_SERVER';
export const ESCROW_WRITE_STELLAR_CONFIG = 'ESCROW_WRITE_STELLAR_CONFIG';

/**
 * Assumed entrypoint for the non-disputed release call: a single string argument, the
 * contract's own escrow id. Not yet verified against a real contract — see the #180 spike
 * write-up (backend/ESCROW_WRITE_PATH_SPIKE.md) for why. Update this if the confirmed
 * contract signature turns out to differ.
 */
const RELEASE_ENTRYPOINT = 'release';

/**
 * Headroom applied to the RPC's `minResourceFee` before it becomes the transaction fee.
 * Soroban resource prices can drift between simulation and submission, so a small margin
 * (10%) keeps an otherwise-valid invocation from failing with `tx_insufficient_fee`.
 */
const RESOURCE_FEE_MARGIN_BASIS_POINTS = 1_100n; // 110% of the simulated minimum
const BASIS_POINTS = 1_000n;

/**
 * Hard upper bound on how long any server-built, client-signed transaction may stay valid.
 *
 * `config.STELLAR_TX_VALIDITY_SECONDS` is operator-tunable (default 60s), but a misconfigured
 * or stale deployment must never be able to hand out an effectively unbounded unsigned XDR:
 * a wallet holding one could submit it days later, long after dispute/deliverable state has
 * changed. Capping here keeps the timebound short regardless of configuration.
 */
export const MAX_RELEASE_TX_VALIDITY_SECONDS = 300;

/** Clamp to [1s, 300s] and normalise fractional/invalid inputs. */
export function clampReleaseTxValidity(seconds: number): number {
  if (!Number.isFinite(seconds)) return MAX_RELEASE_TX_VALIDITY_SECONDS;
  return Math.min(Math.max(Math.floor(seconds), 1), MAX_RELEASE_TX_VALIDITY_SECONDS);
}

export interface UnsignedReleaseTransaction {
  xdr: string;
  network: string;
  networkPassphrase: string;
  contractId: string;
  sourceAccount: string;
}

export interface UnsignedFeeBumpTransaction {
  xdr: string;
  network: string;
  networkPassphrase: string;
  feeAccount: string;
  innerTransactionHash: string;
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
  private readonly logger = new SanitizedLogger(EscrowReleaseTransactionBuilderService.name);

  constructor(
    @Inject(SOROBAN_RPC_SERVER) private readonly rpcServer: SorobanRpc.Server,
    @Inject(ESCROW_WRITE_STELLAR_CONFIG) private readonly config: StellarConfig,
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
    const operation = contract.call(
      RELEASE_ENTRYPOINT,
      nativeToScVal(contractEscrowId, { type: 'string' }),
    );

    const buildWithFee = (fee: string): TransactionBuilder =>
      new TransactionBuilder(account, {
        fee,
        networkPassphrase: this.config.networkPassphrase,
      })
        .addOperation(operation)
        // setTimeout() sets minTime = now and maxTime = now + validity. Capping the
        // configured value means a held XDR expires quickly instead of remaining
        // submittable days later, after dispute/deliverable state has changed.
        .setTimeout(clampReleaseTxValidity(config.STELLAR_TX_VALIDITY_SECONDS));

    // Simulate explicitly so the resource fee estimated from the contract invocation is
    // actually used. Relying on the flat BASE_FEE (or on prepareTransaction's implicit
    // simulation) left above-baseline invocations under-funded at submission time.
    const simulation = await this.rpcServer.simulateTransaction(buildWithFee(BASE_FEE).build());
    if (SorobanRpc.Api.isSimulationError(simulation)) {
      throw new Error(
        `Release simulation failed for escrow ${contractEscrowId}: ${simulation.error}`,
      );
    }

    const minResourceFee = BigInt(simulation.minResourceFee ?? '0');
    const margin =
      (minResourceFee * RESOURCE_FEE_MARGIN_BASIS_POINTS) / BASIS_POINTS - minResourceFee;
    // `assembleTransaction` sets the final fee to `tx.fee + minResourceFee`. Seed the classic
    // fee with BASE_FEE plus the 10% margin so the final fee becomes
    // BASE_FEE + minResourceFee + margin — never the flat base fee alone.
    const seededFee = (BigInt(BASE_FEE) + margin).toString();

    // Assemble auth/footprint from the simulation we already have (no second RPC call).
    const prepared = SorobanRpc.assembleTransaction(
      buildWithFee(seededFee).build(),
      simulation,
    ).build();

    this.logger.log(
      `Built unsigned release transaction for escrow ${contractEscrowId} with fee ${prepared.fee} ` +
        `(minResourceFee=${minResourceFee.toString()})`,
    );

    return {
      xdr: prepared.toXDR(),
      network: this.config.network,
      networkPassphrase: this.config.networkPassphrase,
      contractId: this.config.contractId,
      sourceAccount,
    };
  }

  /**
   * Wraps an already-built unsigned inner transaction in a fee-bump envelope so
   * the client can re-submit it with a higher fee after network congestion has
   * made the original fee insufficient (#869).
   *
   * The fee-bump envelope must be signed by `feeAccount` before submission — the
   * same client-side signing model as `buildRelease`; no keys are held server-side.
   *
   * @param unsignedInnerXdr - XDR of the original unsigned (or signed) inner transaction.
   * @param newFeeStroops    - Total fee in stroops for the fee-bump transaction.
   *                           Must be strictly greater than the inner transaction's fee.
   * @param feeAccount       - Stellar address that will pay the bump fee and sign the envelope.
   */
  bumpFee(
    unsignedInnerXdr: string,
    newFeeStroops: string,
    feeAccount: string,
  ): UnsignedFeeBumpTransaction {
    let innerTx: Transaction;
    try {
      innerTx = new Transaction(unsignedInnerXdr, this.config.networkPassphrase);
    } catch {
      throw new BadRequestException(
        'unsignedInnerXdr is not a valid transaction envelope for this network.',
      );
    }

    const innerFee = BigInt(innerTx.fee);
    const bumpFee = BigInt(newFeeStroops);

    if (bumpFee <= innerFee) {
      throw new BadRequestException(
        `newFeeStroops (${newFeeStroops}) must be greater than the inner transaction fee (${innerFee.toString()}).`,
      );
    }

    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      feeAccount,
      newFeeStroops,
      innerTx,
      this.config.networkPassphrase,
    );

    this.logger.log(
      `Built fee-bump envelope for inner tx ${innerTx.hash().toString('hex')} ` +
        `with new fee ${newFeeStroops} stroops (was ${innerFee.toString()})`,
    );

    return {
      xdr: feeBump.toXDR(),
      network: this.config.network,
      networkPassphrase: this.config.networkPassphrase,
      feeAccount,
      innerTransactionHash: innerTx.hash().toString('hex'),
    };
  }
}
