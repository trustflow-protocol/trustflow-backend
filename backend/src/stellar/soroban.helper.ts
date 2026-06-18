// TODO: Update to new @stellar/stellar-sdk API
// The new SDK has a different API structure for Soroban RPC
// This helper is temporarily disabled until API migration is complete

export async function simulateTransaction(rpcUrl: string, xdr: string): Promise<any> {
  throw new Error('Soroban helper not yet updated for new SDK API');
}

export function isSimulationError(result: any): boolean {
  return false;
}
