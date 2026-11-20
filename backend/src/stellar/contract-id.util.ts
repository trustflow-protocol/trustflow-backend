import { StrKey } from '@stellar/stellar-sdk';

/**
 * Normalizes a Stellar/Soroban contract ID to its canonical StrKey encoding.
 *
 * Contract IDs are case-sensitive, so a value typed into a config file or admin UI with
 * different casing than what's canonically stored elsewhere (e.g. `caaa...` vs `CAAA...`)
 * compares unequal as a raw string even though it addresses the same contract. Round-tripping
 * through StrKey's decode/encode recovers the single canonical form so every comparison, cache
 * key, and RPC filter in the system agrees on one casing (#979).
 *
 * Returns the trimmed input unchanged if it isn't decodable as a contract ID at all, so this
 * stays safe to call before a validator (e.g. `IsValidStellarContract`) has had a chance to
 * reject malformed input.
 */
export function normalizeContractId(contractId: string): string {
  const trimmed = contractId.trim();
  try {
    return StrKey.encodeContract(StrKey.decodeContract(trimmed.toUpperCase()));
  } catch {
    return trimmed;
  }
}
