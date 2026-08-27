import { Injectable } from '@nestjs/common';
import { Horizon } from '@stellar/stellar-sdk';
import { RpcFailoverService } from './rpc-failover.service';

@Injectable()
export class StellarService {
  private server: Horizon.Server;

  constructor(private readonly rpcFailoverService: RpcFailoverService) {
    this.initializeServer();
  }

  private async initializeServer() {
    const endpoint = this.rpcFailoverService.getCurrentHorizonEndpoint();
    this.server = new Horizon.Server(endpoint);
  }

  async getBalance(address: string): Promise<string> {
    return this.withFailover(async server => {
      const account = await server.loadAccount(address);
      const native = account.balances.find((b: any) => b.asset_type === 'native');
      return native?.balance ?? '0';
    });
  }

  async getLatestLedger(): Promise<number> {
    return this.withFailover(async server => {
      const ledger = await server.ledgers().order('desc').limit(1).call();
      return ledger.records[0]?.sequence ?? 0;
    });
  }

  async isAddressActive(address: string): Promise<boolean> {
    return this.withFailover(async server => {
      try {
        await server.loadAccount(address);
        return true;
      } catch {
        return false;
      }
    }, false); // Don't retry for address checks - failure means address doesn't exist
  }

  private async withFailover<T>(
    operation: (server: Horizon.Server) => Promise<T>,
    retryOnFailure: boolean = true,
    maxRetries: number = 2,
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < (retryOnFailure ? maxRetries + 1 : 1); attempt++) {
      try {
        // Get current endpoint (may have changed due to failover)
        const endpoint = this.rpcFailoverService.getCurrentHorizonEndpoint();
        const server = new Horizon.Server(endpoint);
        return await operation(server);
      } catch (error) {
        lastError = error as Error;

        if (retryOnFailure && attempt < maxRetries) {
          // If this wasn't the last attempt, wait a bit before retrying
          await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
        }
      }
    }

    throw lastError || new Error('Operation failed after all retry attempts');
  }
}
