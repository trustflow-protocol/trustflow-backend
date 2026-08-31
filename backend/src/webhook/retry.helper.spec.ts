import { withRetry, isRetryable } from './retry.helper';

describe('isRetryable (#239)', () => {
  it('retries transient network errors', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']) {
      expect(isRetryable(new Error(`connect ${code} 127.0.0.1:443`))).toBe(true);
    }
    expect(isRetryable(new Error('socket hang up'))).toBe(true);
  });

  it('retries real HTTP 5xx responses', () => {
    expect(isRetryable(new Error('500'))).toBe(true);
    expect(isRetryable(new Error('503'))).toBe(true);
    expect(isRetryable(new Error('HTTP 502 Bad Gateway'))).toBe(true);
  });

  it('does not retry 4xx responses', () => {
    expect(isRetryable(new Error('400'))).toBe(false);
    expect(isRetryable(new Error('404'))).toBe(false);
    expect(isRetryable(new Error('429'))).toBe(false);
  });

  it('does not retry a message that merely contains the digit 5', () => {
    expect(isRetryable(new Error('POST https://hooks.example.com/v5/deliver failed'))).toBe(false);
    expect(isRetryable(new Error('payload was 512 bytes'))).toBe(false);
    expect(isRetryable(new Error('connection to port 5000 was refused'))).toBe(false);
    expect(isRetryable(new Error('unexpected token at position 5'))).toBe(false);
  });

  it('handles non-Error values without throwing', () => {
    expect(isRetryable('503')).toBe(true);
    expect(isRetryable(undefined)).toBe(false);
    expect(isRetryable({ weird: true })).toBe(false);
  });
});

describe('withRetry (#239)', () => {
  it('resolves on the first success without retrying', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    await expect(withRetry(fn, 3, 1)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries up to maxAttempts then throws the last error', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('503'));
    await expect(withRetry(fn, 3, 1, isRetryable)).rejects.toThrow('503');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('stops immediately when shouldRetry returns false', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('404'));
    await expect(withRetry(fn, 3, 1, isRetryable)).rejects.toThrow('404');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('recovers if a later attempt succeeds', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValueOnce('recovered');
    await expect(withRetry(fn, 3, 1, isRetryable)).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
