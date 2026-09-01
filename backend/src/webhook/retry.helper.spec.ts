import { withRetry, isRetryable } from './retry.helper';

// ─── withRetry ────────────────────────────────────────────────────────────────

describe('withRetry()', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns the resolved value on the first attempt', async () => {
    const fn = jest.fn().mockResolvedValue('ok');

    const result = await withRetry(fn, 3, 100);

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and succeeds before exhausting attempts', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue('success');

    const promise = withRetry(fn, 3, 50);
    // Flush the first delay (50ms * 1 = 50ms)
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws the last error after all attempts are exhausted', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('persistent failure'));

    const promise = withRetry(fn, 3, 50);
    await jest.runAllTimersAsync();

    await expect(promise).rejects.toThrow('persistent failure');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('uses linear backoff: delay grows as baseDelayMs × attempt', async () => {
    const delays: number[] = [];
    const originalSetTimeout = global.setTimeout;

    // Spy to capture the delay values passed to setTimeout.
    jest
      .spyOn(global, 'setTimeout')
      .mockImplementation((cb: (...args: unknown[]) => void, ms?: number) => {
        if (ms !== undefined) delays.push(ms);
        return originalSetTimeout(cb, 0) as unknown as ReturnType<typeof setTimeout>;
      });

    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('fail-1'))
      .mockRejectedValueOnce(new Error('fail-2'))
      .mockResolvedValue('ok');

    await withRetry(fn, 3, 100);

    // Attempt 1 fails → delay 100 * 1 = 100ms
    // Attempt 2 fails → delay 100 * 2 = 200ms
    // Attempt 3 succeeds → no delay
    expect(delays).toEqual([100, 200]);

    jest.restoreAllMocks();
  });

  it('does not wait after the final failing attempt', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('always fails'));
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    const promise = withRetry(fn, 2, 100);
    await jest.runAllTimersAsync();
    await expect(promise).rejects.toThrow();

    // With maxAttempts=2 there should be exactly 1 inter-attempt delay.
    const delayedCalls = setTimeoutSpy.mock.calls.filter(([, ms]) => (ms ?? 0) > 0);
    expect(delayedCalls).toHaveLength(1);

    jest.restoreAllMocks();
  });

  it('stops immediately when shouldRetry returns false', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('404'))
      .mockResolvedValue('should not get here');

    const shouldRetry = jest.fn().mockReturnValue(false);

    const promise = withRetry(fn, 5, 50, shouldRetry);
    await jest.runAllTimersAsync();
    await expect(promise).rejects.toThrow('404');

    expect(fn).toHaveBeenCalledTimes(1); // stopped after first failure
    expect(shouldRetry).toHaveBeenCalledTimes(1);
  });

  it('continues retrying while shouldRetry returns true', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('502'))
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValue('eventually ok');

    const shouldRetry = jest.fn().mockReturnValue(true);

    const promise = withRetry(fn, 3, 50, shouldRetry);
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('eventually ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('defaults shouldRetry to "always retry" when the argument is omitted', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('random error'))
      .mockResolvedValue('recovered');

    const promise = withRetry(fn, 3, 50); // no shouldRetry arg
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('wraps a non-Error rejection in a new Error', async () => {
    const fn = jest.fn().mockRejectedValue('string rejection');

    const promise = withRetry(fn, 1, 50);
    await jest.runAllTimersAsync();

    await expect(promise).rejects.toThrow('string rejection');
  });

  it('re-throws the original Error instance on exhaustion', async () => {
    const err = new TypeError('specific error type');
    const fn = jest.fn().mockRejectedValue(err);

    const promise = withRetry(fn, 1, 50);
    await jest.runAllTimersAsync();

    await expect(promise).rejects.toBe(err);
  });
});

// ─── isRetryable ──────────────────────────────────────────────────────────────

describe('isRetryable()', () => {
  // ─── Network errors ───────────────────────────────────────────────────────

  it.each([
    ['ECONNREFUSED', 'ECONNREFUSED connect ECONNREFUSED 127.0.0.1:3000'],
    ['ECONNRESET', 'read ECONNRESET'],
    ['ETIMEDOUT', 'connect ETIMEDOUT 10.0.0.1:443'],
    ['EAI_AGAIN', 'getaddrinfo EAI_AGAIN example.com'],
    ['ENOTFOUND', 'getaddrinfo ENOTFOUND example.com'],
    ['EPIPE', 'write EPIPE'],
    ['socket hang up', 'socket hang up'],
  ])('returns true for network error: %s', (_label, message) => {
    expect(isRetryable(new Error(message))).toBe(true);
  });

  it('is case-insensitive for network error codes', () => {
    expect(isRetryable(new Error('econnrefused'))).toBe(true);
    expect(isRetryable(new Error('Socket Hang Up'))).toBe(true);
  });

  // ─── HTTP 5xx ─────────────────────────────────────────────────────────────

  it.each([500, 502, 503, 504, 520, 599])('returns true for HTTP %d (5xx)', status => {
    expect(isRetryable(new Error(String(status)))).toBe(true);
  });

  it('returns true for verbose 5xx messages like "HTTP 502 Bad Gateway"', () => {
    expect(isRetryable(new Error('HTTP 502 Bad Gateway'))).toBe(true);
  });

  // ─── HTTP 4xx ─────────────────────────────────────────────────────────────

  it.each([400, 401, 403, 404, 422, 429])(
    'returns false for HTTP %d (4xx) — non-retryable',
    status => {
      expect(isRetryable(new Error(String(status)))).toBe(false);
    },
  );

  it('returns false for a bare "404" message', () => {
    expect(isRetryable(new Error('404'))).toBe(false);
  });

  // ─── HTTP 2xx / 3xx ───────────────────────────────────────────────────────

  it.each([200, 201, 301, 302])('returns false for HTTP %d (2xx/3xx)', status => {
    expect(isRetryable(new Error(String(status)))).toBe(false);
  });

  // ─── Ambiguous / unrecognised errors ─────────────────────────────────────

  it('returns false for a generic non-network, non-HTTP error message', () => {
    expect(isRetryable(new Error('something went wrong'))).toBe(false);
  });

  it('returns false for an empty error message', () => {
    expect(isRetryable(new Error(''))).toBe(false);
  });

  it('does not match the digit "5" inside a URL or other context', () => {
    // The old bug: error.message.includes('5') would match port numbers etc.
    expect(isRetryable(new Error('failed to connect to host:5432'))).toBe(false);
    expect(isRetryable(new Error('error at line 5'))).toBe(false);
  });

  it('handles a non-Error value gracefully', () => {
    expect(isRetryable('ECONNRESET')).toBe(true);
    expect(isRetryable(null)).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
    expect(isRetryable(500)).toBe(false); // number, not Error with message "500"
  });
});
