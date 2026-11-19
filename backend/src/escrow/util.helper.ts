/**
 * Generate a unique identifier with a descriptive prefix.
 * Uses timestamp + random suffix since the `uuid` package is not a dependency.
 */
export function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Sum a list of numeric strings (XLM amounts) and return the result as a
 * string. Uses Number arithmetic — sufficient for this in-memory prototype;
 * a production system would use BigInt or a decimal library for precision.
 */
export function sumAmounts(amounts: string[]): string {
  const total = amounts.reduce((acc, a) => acc + Number(a || 0), 0);
  return Number.isInteger(total) ? String(total) : String(parseFloat(total.toFixed(7)));
}
