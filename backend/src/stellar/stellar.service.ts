import { Injectable } from '@nestjs/common';
import { Horizon } from '@stellar/stellar-sdk';

@Injectable()
export class StellarService {
  private server: Horizon.Server;

  constructor() {
    const url = process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
    this.server = new Horizon.Server(url);
  }

  async getBalance(address: string): Promise<string> {
    const account = await this.server.loadAccount(address);
    const native = account.balances.find((b: any) => b.asset_type === 'native');
    return native?.balance ?? '0';
  }

  async getLatestLedger(): Promise<number> {
    const ledger = await this.server.ledgers().order('desc').limit(1).call();
    return ledger.records[0]?.sequence ?? 0;
  }

  async isAddressActive(address: string): Promise<boolean> {
    try {
      await this.server.loadAccount(address);
      return true;
    } catch {
      return false;
    }
  }
}
