import { Injectable, Logger } from '@nestjs/common';
import { rpc as SorobanRpc, xdr, nativeToScVal, scValToNative } from '@stellar/stellar-sdk';
import { EscrowChainStateClient } from './escrow-chain-state.client';
import { ChainEscrowRecord } from './escrow-reconciliation.types';
import { STELLAR_CONFIG } from '../stellar/stellar.config';

/**
 * Storage-key convention assumed for the TrustFlow escrow contract: each escrow is a
 * persistent contract-data entry keyed by the vector [symbol("Escrow"), string(contractEscrowId)],
 * holding a map with depositor/beneficiary/amount/status fields — mirroring the event
 * shape event-processor.service.ts already parses (escrow_created/funded/released/disputed).
 * No contract source lives in this repo to verify the layout against; if the deployed
 * contract's storage differs, only this file needs to change since the rest of the
 * reconciler depends solely on the EscrowChainStateClient contract.
 *
 * When TRUSTFLOW_CONTRACT_ID is unset (the default in local dev, tests, and CI) this
 * falls back to an in-memory simulated store instead of making real Soroban RPC calls,
 * mirroring how the IPFS pin providers (see BaseHttpPinProvider) degrade without
 * credentials — keeping reconciliation fully testable without network access while
 * still exercising the real RPC path once a contract ID is configured.
 */
@Injectable()
export class SorobanEscrowChainStateClient extends EscrowChainStateClient {
  private readonly logger = new Logger(SorobanEscrowChainStateClient.name);
  private readonly rpcServer: SorobanRpc.Server;
  private readonly simulatedStore = new Map<string, ChainEscrowRecord>();

  constructor() {
    super();
    this.rpcServer = new SorobanRpc.Server(STELLAR_CONFIG.sorobanRpcUrl);
  }

  get isConfigured(): boolean {
    return Boolean(STELLAR_CONFIG.contractId);
  }

  /** Test/ops hook for seeding the simulated store when no contract is configured. */
  seedSimulated(record: ChainEscrowRecord): void {
    this.simulatedStore.set(record.contractEscrowId, record);
  }

  async getEscrow(contractEscrowId: string): Promise<ChainEscrowRecord | undefined> {
    if (!this.isConfigured) {
      return this.simulatedStore.get(contractEscrowId);
    }

    const key = xdr.ScVal.scvVec([
      nativeToScVal('Escrow', { type: 'symbol' }),
      nativeToScVal(contractEscrowId, { type: 'string' }),
    ]);

    try {
      const entry = await this.rpcServer.getContractData(STELLAR_CONFIG.contractId, key);
      const native = scValToNative(entry.val.contractData().val());
      return this.toChainRecord(contractEscrowId, native);
    } catch (error) {
      if (this.isNotFound(error)) return undefined;
      this.logger.error(
        `Failed to read chain state for escrow ${contractEscrowId}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  private toChainRecord(
    contractEscrowId: string,
    native: Record<string, unknown>,
  ): ChainEscrowRecord {
    return {
      contractEscrowId,
      depositor: String(native.depositor),
      beneficiary: String(native.beneficiary),
      amountXLM: String(native.amount),
      status: native.status as ChainEscrowRecord['status'],
    };
  }

  private isNotFound(error: unknown): boolean {
    const message =
      error instanceof Error ? error.message : (error as { message?: string } | undefined)?.message;
    return typeof message === 'string' && message.includes('Contract data not found');
  }
}
