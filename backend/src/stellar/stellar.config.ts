import { config } from '../config/env.config';

const VALID_NETWORKS = ['TESTNET', 'PUBLIC'] as const;
type StellarNetworkValue = (typeof VALID_NETWORKS)[number];

const NETWORK_PASSPHRASES: Record<StellarNetworkValue, string> = {
  PUBLIC: 'Public Global Stellar Network ; September 2015',
  TESTNET: 'Test SDF Network ; September 2015',
};

export interface StellarConfig {
  network: StellarNetworkValue;
  // Single endpoint fallback (for backward compatibility)
  horizonUrl: string;
  sorobanRpcUrl: string;
  // Multiple endpoints for failover (comma-separated)
  horizonEndpoints: string[];
  sorobanRpcEndpoints: string[];
  contractId: string;
  networkPassphrase: string;
}

let cachedStellarConfig: StellarConfig | null = null;

/**
 * Canonical accepted values for STELLAR_NETWORK:
 *   - "TESTNET" — Stellar Testnet (Test SDF Network ; September 2015)
 *   - "PUBLIC"  — Stellar Mainnet, matching @stellar/stellar-sdk's Networks.PUBLIC constant
 *
 * The legacy value "MAINNET" is also accepted as an alias for "PUBLIC" to avoid breaking
 * existing deployments, but "PUBLIC" is the preferred production value per Stellar SDK conventions.
 *
 * An unrecognized value causes the app to throw rather than silently defaulting to testnet
 * (which would be a dangerous misconfiguration in production).
 *
 * Computed lazily and memoized on first call rather than as a module-level constant: this
 * file is reached from the AppModule import graph (via event-ingestion, escrow-write, the
 * Soroban indexer, etc.), and `config.*` throws until `validateEnv()` has run. A module-level
 * read would make simply importing this file order-dependent on `validateEnv()`; deferring
 * the read to first call keeps it safe to import at any time (see #428).
 */
export function getStellarConfig(): StellarConfig {
  if (cachedStellarConfig) {
    return cachedStellarConfig;
  }

  const rawNetwork = config.STELLAR_NETWORK;
  // Accept "MAINNET" as an alias for "PUBLIC" (legacy compatibility)
  const normalizedNetwork = rawNetwork === 'MAINNET' ? 'PUBLIC' : rawNetwork;

  if (!(VALID_NETWORKS as readonly string[]).includes(normalizedNetwork)) {
    throw new Error(
      `Invalid STELLAR_NETWORK value: "${rawNetwork}". ` +
        `Accepted values are "TESTNET" or "PUBLIC" (the Stellar SDK canonical name for mainnet). ` +
        `"MAINNET" is also accepted as a legacy alias for "PUBLIC".`,
    );
  }

  cachedStellarConfig = {
    network: normalizedNetwork as StellarNetworkValue,
    horizonUrl: config.STELLAR_HORIZON_URL,
    sorobanRpcUrl: config.SOROBAN_RPC_URL,
    horizonEndpoints: (config.STELLAR_HORIZON_ENDPOINTS || config.STELLAR_HORIZON_URL)
      .split(',')
      .map(url => url.trim()),
    sorobanRpcEndpoints: (config.SOROBAN_RPC_ENDPOINTS || config.SOROBAN_RPC_URL)
      .split(',')
      .map(url => url.trim()),
    contractId: config.TRUSTFLOW_CONTRACT_ID || '',
    networkPassphrase: NETWORK_PASSPHRASES[normalizedNetwork as StellarNetworkValue],
  };

  return cachedStellarConfig;
}
