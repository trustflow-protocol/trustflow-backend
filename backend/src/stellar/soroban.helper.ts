import { rpc as SorobanRpc } from '@stellar/stellar-sdk';

export async function simulateTransaction(
  rpcUrl: string,
  xdr: string,
): Promise<SorobanRpc.Api.SimulateTransactionResponse> {
  const server = new SorobanRpc.Server(rpcUrl);
  const tx = new (await import('@stellar/stellar-sdk')).Transaction(
    xdr,
    (await import('@stellar/stellar-sdk')).Networks.TESTNET,
  );
  return server.simulateTransaction(tx);
}

export function isSimulationError(result: SorobanRpc.Api.SimulateTransactionResponse): boolean {
  return SorobanRpc.Api.isSimulationError(result);
}
