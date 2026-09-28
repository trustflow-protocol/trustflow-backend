/**
 * Shared Redis transaction-integrity helpers.
 *
 * Redis `MULTI`/`EXEC` is not ACID in the way a SQL transaction is, and its two failure modes
 * are easy to mistake for success:
 *
 *  1. **Queue-time error** — a malformed command makes `exec()` reject outright.
 *  2. **Runtime error in one queued command** — `exec()` still *resolves*, returning an array
 *     of `[Error, result]` pairs. Redis does **not** roll back the commands that succeeded.
 *
 * Case 2 is the dangerous one: the entity may be written while its index update silently
 * failed, leaving persistent inconsistency. Detecting it requires inspecting every entry, and
 * the failure must then be surfaced rather than absorbed — a caller that is told "saved" when
 * only half the write landed is how "gig created but escrow failed" states appear.
 *
 * `RedisTransactionError` gives that condition a type, so callers stop discriminating on
 * English substrings of a message (which both services previously did, and which would break
 * the moment the wording changed).
 */

export type TransactionFailureReason = 'aborted' | 'command-failed';

/** Signals that a `MULTI`/`EXEC` did not apply as a unit. */
export class RedisTransactionError extends Error {
  constructor(
    readonly reason: TransactionFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'RedisTransactionError';
    // Required so `instanceof` survives the ES5/ES2021 class-extends-Error downlevel.
    Object.setPrototypeOf(this, RedisTransactionError.prototype);
  }

  /** True when the failure means part of the write may already be durable in Redis. */
  get mayBePartiallyApplied(): boolean {
    return this.reason === 'command-failed';
  }
}

export type ExecResults = Array<[Error | null, unknown]> | null;

/**
 * Throws {@link RedisTransactionError} unless every queued command applied.
 *
 * @param results whatever `exec()` resolved to; `null` means the transaction was aborted
 *   (a `WATCH` conflict, or an explicit `DISCARD`).
 */
export function assertTransactionApplied(results: ExecResults): void {
  if (results === null) {
    throw new RedisTransactionError(
      'aborted',
      'Redis transaction aborted (exec() returned null — a WATCH conflict, or an explicit DISCARD)',
    );
  }

  for (const [error] of results) {
    if (error) {
      throw new RedisTransactionError(
        'command-failed',
        `Redis transaction command failed: ${error.message}`,
      );
    }
  }
}

/**
 * True when `error` reports a transaction-integrity failure rather than a connectivity
 * problem. Use this to decide whether degrading to a non-transactional store is even safe:
 * it is not, because the earlier commands in the batch may already be durable.
 */
export function isTransactionIntegrityError(error: unknown): error is RedisTransactionError {
  return error instanceof RedisTransactionError;
}
