/**
 * Canonical accepted values for STELLAR_NETWORK:
 *   - "TESTNET" — Stellar Testnet (Test SDF Network ; September 2015)
 *   - "PUBLIC"  — Stellar Mainnet, matching @stellar/stellar-sdk's Networks.PUBLIC constant
 *
 * The legacy value "MAINNET" is also accepted as an alias for "PUBLIC" to avoid breaking
 * existing deployments, but "PUBLIC" is the preferred production value per Stellar SDK conventions.
 *
 * An unrecognized value causes the app to throw at startup rather than silently
 * defaulting to testnet (which would be a dangerous misconfiguration in production).
 */
const rawNetwork = process.env.STELLAR_NETWORK || 'TESTNET';

// Accept "MAINNET" as an alias for "PUBLIC" (legacy compatibility)
const normalizedNetwork = rawNetwork === 'MAINNET' ? 'PUBLIC' : rawNetwork;

const VALID_NETWORKS = ['TESTNET', 'PUBLIC'] as const;
type StellarNetworkValue = (typeof VALID_NETWORKS)[number];

if (!(VALID_NETWORKS as readonly string[]).includes(normalizedNetwork)) {
  throw new Error(
    `Invalid STELLAR_NETWORK value: "${rawNetwork}". ` +
      `Accepted values are "TESTNET" or "PUBLIC" (the Stellar SDK canonical name for mainnet). ` +
      `"MAINNET" is also accepted as a legacy alias for "PUBLIC".`,
  );
}

const NETWORK_PASSPHRASES: Record<StellarNetworkValue, string> = {
  PUBLIC: 'Public Global Stellar Network ; September 2015',
  TESTNET: 'Test SDF Network ; September 2015',
};

export const STELLAR_CONFIG = {
  network: normalizedNetwork as StellarNetworkValue,
  // Single endpoint fallback (for backward compatibility)
  horizonUrl: process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org',
  sorobanRpcUrl: process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org',
  // Multiple endpoints for failover (comma-separated)
  horizonEndpoints: (process.env.STELLAR_HORIZON_ENDPOINTS || 'https://horizon-testnet.stellar.org')
    .split(',')
    .map(url => url.trim()),
  sorobanRpcEndpoints: (process.env.SOROBAN_RPC_ENDPOINTS || 'https://soroban-testnet.stellar.org')
    .split(',')
    .map(url => url.trim()),
  contractId: process.env.TRUSTFLOW_CONTRACT_ID || '',
  networkPassphrase: NETWORK_PASSPHRASES[normalizedNetwork as StellarNetworkValue],
};
