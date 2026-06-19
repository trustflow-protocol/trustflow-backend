import { Horizon } from '@stellar/stellar-sdk';

export function buildHorizonServer(url: string): Horizon.Server {
  return new Horizon.Server(url, { allowHttp: url.startsWith('http://') });
}

export async function waitForTransaction(
  server: Horizon.Server,
  txHash: string,
  maxAttempts = 10,
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await server.transactions().transaction(txHash).call();
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  return false;
}
