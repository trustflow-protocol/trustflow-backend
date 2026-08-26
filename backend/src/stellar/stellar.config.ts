export const STELLAR_CONFIG = {
  network: process.env.STELLAR_NETWORK || 'TESTNET',
  // Single endpoint fallback (for backward compatibility)
  horizonUrl: process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org',
  sorobanRpcUrl: process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org',
  // Multiple endpoints for failover (comma-separated)
  horizonEndpoints: (process.env.STELLAR_HORIZON_ENDPOINTS || 'https://horizon-testnet.stellar.org').split(',').map(url => url.trim()),
  sorobanRpcEndpoints: (process.env.SOROBAN_RPC_ENDPOINTS || 'https://soroban-testnet.stellar.org').split(',').map(url => url.trim()),
  contractId: process.env.TRUSTFLOW_CONTRACT_ID || '',
  networkPassphrase:
    process.env.STELLAR_NETWORK === 'MAINNET'
      ? 'Public Global Stellar Network ; September 2015'
      : 'Test SDF Network ; September 2015',
};
