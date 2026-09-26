import { ESCROW_STATUSES, EscrowStatus } from '../escrow/escrow.service';
import { STELLAR_ADDRESS_REGEX } from '../escrow/escrow.dto';
import { ChainEscrowRecord } from './escrow-reconciliation.types';

/** Thrown when a value decoded from the escrow contract is not a well-formed escrow record. */
export class InvalidChainStateError extends Error {
  constructor(
    readonly contractEscrowId: string,
    message: string,
  ) {
    super(`Invalid chain state for escrow ${contractEscrowId}: ${message}`);
    this.name = 'InvalidChainStateError';
  }
}

/**
 * Explicit mapping of the contract's enum encodings (lower-cased) to EscrowStatus. The contract
 * source is not available here, so only encodings we can name are accepted; anything else is
 * rejected rather than guessed at. Extend this table once the on-chain encoding is confirmed.
 */
const STATUS_MAP: Record<string, EscrowStatus> = Object.fromEntries(
  ESCROW_STATUSES.map(s => [s, s]),
);

const DECIMAL = /^\d+(\.\d+)?$/;

function requiredString(id: string, native: Record<string, unknown>, field: string): string {
  const value = native[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidChainStateError(id, `missing or non-string field "${field}"`);
  }
  if ((field === 'depositor' || field === 'beneficiary') && !STELLAR_ADDRESS_REGEX.test(value)) {
    throw new InvalidChainStateError(id, `field "${field}" is not a valid Stellar address`);
  }
  return value;
}

function decodeStatus(id: string, raw: unknown): EscrowStatus {
  // scValToNative decodes a unit-variant enum as a one-element array, e.g. ['Active'].
  const value = Array.isArray(raw) && raw.length === 1 ? raw[0] : raw;
  const mapped = typeof value === 'string' ? STATUS_MAP[value.trim().toLowerCase()] : undefined;
  if (!mapped) {
    throw new InvalidChainStateError(id, `unrecognised status ${JSON.stringify(String(value))}`);
  }
  return mapped;
}

/** Validates and normalises a decoded contract value into a ChainEscrowRecord. */
export function parseChainEscrow(contractEscrowId: string, native: unknown): ChainEscrowRecord {
  if (native === null || typeof native !== 'object' || Array.isArray(native)) {
    throw new InvalidChainStateError(contractEscrowId, 'contract value is not an object');
  }
  const record = native as Record<string, unknown>;

  const rawAmount = record.amount;
  const amount =
    typeof rawAmount === 'bigint' || typeof rawAmount === 'number' ? String(rawAmount) : rawAmount;
  if (typeof amount !== 'string' || !DECIMAL.test(amount)) {
    throw new InvalidChainStateError(contractEscrowId, 'amount is not a decimal string');
  }

  return {
    contractEscrowId,
    depositor: requiredString(contractEscrowId, record, 'depositor'),
    beneficiary: requiredString(contractEscrowId, record, 'beneficiary'),
    amountXLM: amount,
    status: decodeStatus(contractEscrowId, record.status),
  };
}
