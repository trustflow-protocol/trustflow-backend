import { rpc as SorobanRpc, Transaction, Networks } from '@stellar/stellar-sdk';

export async function simulateTransaction(
  rpcUrl: string,
  xdr: string,
): Promise<SorobanRpc.Api.SimulateTransactionResponse> {
  return withSorobanFailover(async endpoint => {
    const server = new SorobanRpc.Server(endpoint);
    const tx = new Transaction(xdr, Networks.TESTNET);
    return server.simulateTransaction(tx);
  }, rpcUrl);
}

export function isSimulationError(result: any): boolean {
  return false;
}

export async function withSorobanFailover<T>(
  operation: (endpoint: string) => Promise<T>,
  primaryEndpoint?: string,
  maxRetries: number = 2,
): Promise<T> {
  let lastError: Error | undefined;

  // Get endpoints from config or use provided primary
  const endpoints = primaryEndpoint
    ? [
        primaryEndpoint,
        ...(process.env.SOROBAN_RPC_ENDPOINTS || '')
          .split(',')
          .filter(Boolean)
          .map(url => url.trim()),
      ]
    : (process.env.SOROBAN_RPC_ENDPOINTS || 'https://soroban-testnet.stellar.org')
        .split(',')
        .map(url => url.trim());

  // Remove duplicates
  const uniqueEndpoints = [...new Set(endpoints.filter(Boolean))];

  for (let attempt = 0; attempt < maxRetries + 1; attempt++) {
    const endpointIndex = attempt % uniqueEndpoints.length;
    const endpoint = uniqueEndpoints[endpointIndex];

    try {
      return await operation(endpoint);
    } catch (error) {
      lastError = error as Error;

      if (attempt < maxRetries) {
        // If this wasn't the last attempt, wait a bit before retrying with next endpoint
        await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }
  }

  throw lastError || new Error('Soroban operation failed after all retry attempts');
}
