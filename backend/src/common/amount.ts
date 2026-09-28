import BigNumber from 'bignumber.js';

export const STROOPS_PER_XLM = 10_000_000;
const MAX_DECIMAL_PLACES = 7;

/**
 * Amount handling utilities for XLM amounts carried as decimal strings.
 *
 * All amounts are normalized to decimal strings with up to 7 decimal places.
 * On-chain, amounts are represented in stroops (integer, 1 XLM = 10,000,000 stroops).
 * This module enforces proper parsing, validation, and conversion between the two.
 */

/**
 * Parses a value into a BigNumber, validating it is a valid decimal string.
 * Throws on invalid input.
 */
export function parseAmount(value: unknown): BigNumber {
  if (typeof value !== 'string') {
    throw new Error(`Amount must be a string, got ${typeof value}`);
  }
  const bn = new BigNumber(value);
  if (bn.isNaN()) {
    throw new Error(`Invalid amount: ${value} is not a valid number`);
  }
  return bn;
}

/**
 * Validates that an amount is non-negative and has at most 7 decimal places.
 * Throws on invalid input. Returns the validated normalized string.
 */
export function validateAmount(value: unknown): string {
  const bn = parseAmount(value);
  if (bn.isNegative()) {
    throw new Error(`Amount must be non-negative, got ${bn.toFixed()}`);
  }
  return normalizeAmount(bn.toFixed());
}

/**
 * Normalizes an amount string to exactly the decimal representation,
 * removing trailing zeros after the decimal point but preserving the numeric value.
 * For amounts with more than 7 decimal places, rounds down to 7 places.
 */
export function normalizeAmount(value: unknown): string {
  const bn = parseAmount(value);
  if (bn.decimalPlaces() > MAX_DECIMAL_PLACES) {
    return bn.decimalPlaces(MAX_DECIMAL_PLACES, BigNumber.ROUND_DOWN).toFixed();
  }
  return bn.toFixed();
}

/**
 * Compares two amounts numerically (as normalized strings).
 * Returns -1 if a < b, 0 if a == b, 1 if a > b.
 */
export function compareAmounts(a: unknown, b: unknown): number {
  const aBn = parseAmount(a);
  const bBn = parseAmount(b);
  if (aBn.isLessThan(bBn)) return -1;
  if (aBn.isGreaterThan(bBn)) return 1;
  return 0;
}

/**
 * Sums multiple amounts. Returns normalized amount string.
 */
export function sumAmounts(amounts: unknown[]): string {
  let sum = new BigNumber(0);
  for (const amount of amounts) {
    sum = sum.plus(parseAmount(amount));
  }
  return normalizeAmount(sum.toFixed());
}

/**
 * Converts stroops (on-chain integer) to XLM amount string (max 7 decimal places).
 */
export function stroopsToXLM(stroops: number | bigint | string): string {
  const bn = new BigNumber(stroops.toString()).dividedBy(STROOPS_PER_XLM);
  return normalizeAmount(bn.toFixed());
}

/**
 * Converts XLM amount string to stroops (on-chain integer, rounded down).
 */
export function xlmToStroops(xlm: unknown): bigint {
  const bn = parseAmount(xlm).multipliedBy(STROOPS_PER_XLM);
  return BigInt(bn.integerValue(BigNumber.ROUND_DOWN).toFixed(0));
}

/**
 * Checks if two amounts are equal after normalization.
 */
export function amountsEqual(a: unknown, b: unknown): boolean {
  return compareAmounts(a, b) === 0;
}

/**
 * Checks if amount a is less than amount b.
 */
export function amountLessThan(a: unknown, b: unknown): boolean {
  return compareAmounts(a, b) < 0;
}

/**
 * Checks if amount a is less than or equal to amount b.
 */
export function amountLessThanOrEqual(a: unknown, b: unknown): boolean {
  return compareAmounts(a, b) <= 0;
}

/**
 * Checks if amount a is greater than amount b.
 */
export function amountGreaterThan(a: unknown, b: unknown): boolean {
  return compareAmounts(a, b) > 0;
}

/**
 * Checks if amount a is greater than or equal to amount b.
 */
export function amountGreaterThanOrEqual(a: unknown, b: unknown): boolean {
  return compareAmounts(a, b) >= 0;
}
