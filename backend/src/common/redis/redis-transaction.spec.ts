import {
  assertTransactionApplied,
  isTransactionIntegrityError,
  RedisTransactionError,
} from './redis-transaction';

describe('redis-transaction', () => {
  describe('assertTransactionApplied', () => {
    it('passes when every queued command succeeded', () => {
      expect(() =>
        assertTransactionApplied([
          [null, 'OK'],
          [null, 1],
          [null, null],
        ]),
      ).not.toThrow();
    });

    it('throws an aborted error when exec() returns null', () => {
      expect(() => assertTransactionApplied(null)).toThrow(RedisTransactionError);
      try {
        assertTransactionApplied(null);
      } catch (error) {
        expect((error as RedisTransactionError).reason).toBe('aborted');
      }
    });

    it('throws a command-failed error when any command failed', () => {
      try {
        assertTransactionApplied([
          [null, 'OK'],
          [new Error('WRONGTYPE Operation against a key'), null],
        ]);
        throw new Error('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(RedisTransactionError);
        expect((error as RedisTransactionError).reason).toBe('command-failed');
        expect((error as RedisTransactionError).message).toContain('WRONGTYPE');
      }
    });

    it('detects a failure in the last entry, not just the first', () => {
      // A partial write is just as damaging wherever in the batch it occurs.
      expect(() =>
        assertTransactionApplied([
          [null, 'OK'],
          [null, 'OK'],
          [new Error('boom'), null],
        ]),
      ).toThrow(RedisTransactionError);
    });

    it('treats an empty result set as success', () => {
      expect(() => assertTransactionApplied([])).not.toThrow();
    });
  });

  describe('RedisTransactionError', () => {
    it('flags a command failure as possibly partially applied', () => {
      // The earlier commands in the batch are already durable, which is why degrading to a
      // non-transactional store is unsafe in this case.
      expect(new RedisTransactionError('command-failed', 'x').mayBePartiallyApplied).toBe(true);
    });

    it('does not flag an abort as partially applied', () => {
      expect(new RedisTransactionError('aborted', 'x').mayBePartiallyApplied).toBe(false);
    });

    it('survives instanceof across the transpiled class boundary', () => {
      expect(new RedisTransactionError('aborted', 'x')).toBeInstanceOf(Error);
      expect(new RedisTransactionError('aborted', 'x')).toBeInstanceOf(RedisTransactionError);
      expect(new RedisTransactionError('aborted', 'x').name).toBe('RedisTransactionError');
    });
  });

  describe('isTransactionIntegrityError', () => {
    it('recognises a transaction error', () => {
      expect(isTransactionIntegrityError(new RedisTransactionError('aborted', 'x'))).toBe(true);
    });

    it('does not mistake a connectivity error for an integrity failure', () => {
      // This distinction is the whole point: a connection error means nothing was applied
      // and degrading is safe; an integrity error means it may have been.
      expect(isTransactionIntegrityError(new Error('ECONNREFUSED'))).toBe(false);
      expect(isTransactionIntegrityError('boom')).toBe(false);
      expect(isTransactionIntegrityError(undefined)).toBe(false);
    });

    it('does not rely on the message text', () => {
      // The previous implementation matched English substrings, so rewording the message
      // would have silently disabled the safety check.
      const error = new Error('Redis transaction aborted (exec() returned null)');
      expect(isTransactionIntegrityError(error)).toBe(false);
    });
  });
});
