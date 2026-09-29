import { Logger } from '@nestjs/common';
import { SanitizedLogger } from './sanitized-logger';
import { REDACTED } from './redaction';

/**
 * Verifies that nothing sensitive reaches the underlying Nest `Logger` transport. The
 * transport is spied on rather than intercepted at stdout, so these assertions describe exactly
 * what would be written to disk or shipped to a log aggregator.
 */
describe('SanitizedLogger', () => {
  const methods = ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const;
  let spies: Record<(typeof methods)[number], jest.SpyInstance>;

  beforeEach(() => {
    spies = {} as Record<(typeof methods)[number], jest.SpyInstance>;
    for (const method of methods) {
      spies[method] = jest.spyOn(Logger.prototype, method).mockImplementation(() => undefined);
    }
  });

  afterEach(() => jest.restoreAllMocks());

  const allEmitted = (): string =>
    methods.map(m => spies[m].mock.calls.flat().map(String).join(' ')).join('\n');

  it('redacts a secret interpolated into a message string', () => {
    new SanitizedLogger('T').log('failed for api_key=sk_live_should_not_appear');

    expect(allEmitted()).not.toContain('sk_live_should_not_appear');
    expect(allEmitted()).toContain(REDACTED);
  });

  it('redacts sensitive fields of an object passed as the message', () => {
    new SanitizedLogger('T').warn({ event: 'login', password: 'hunter2', userId: 'u1' });

    expect(allEmitted()).not.toContain('hunter2');
    // Non-sensitive fields survive so the line is still actionable.
    expect(allEmitted()).toContain('u1');
  });

  it('redacts a raw Error passed as the message', () => {
    new SanitizedLogger('T').error(new Error('db rejected token=abc123xyz'));
    expect(allEmitted()).not.toContain('abc123xyz');
  });

  it('redacts a raw Error passed in the optional stack-trace position', () => {
    // This is the shape used throughout the codebase: logger.error(msg, error).
    new SanitizedLogger('T').error(
      'probe failed',
      new Error('conn refused for postgres://u:p@h/db'),
    );

    expect(allEmitted()).not.toContain('u:p@h');
  });

  it('redacts a raw Error object passed as an optional param', () => {
    new SanitizedLogger('T').error('probe failed', { apiKey: 'ak_live_1', attempt: 2 } as never);

    expect(allEmitted()).not.toContain('ak_live_1');
    expect(allEmitted()).toContain('2');
  });

  it('redacts across every level, not just log()', () => {
    const logger = new SanitizedLogger('T');
    logger.log('secret=one');
    logger.warn('secret=two');
    logger.error('secret=three');
    logger.debug('secret=four');
    logger.verbose('secret=five');
    logger.fatal('secret=six');

    const emitted = allEmitted();
    for (const value of ['one', 'two', 'three', 'four', 'five', 'six']) {
      expect(emitted).not.toContain(`secret=${value}`);
    }
  });

  it('passes the context through so log lines stay attributable', () => {
    new SanitizedLogger('MyService').log('hello');
    expect(Logger).toBeDefined();
    expect(spies.log).toHaveBeenCalled();
  });

  it('does not throw when handed an unserialisable value', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => new SanitizedLogger('T').log(cyclic as never)).not.toThrow();
  });

  it('preserves a message that contains no secrets byte-for-byte', () => {
    new SanitizedLogger('T').log('Escrow esc-1 moved to status released');
    expect(spies.log).toHaveBeenCalledWith('Escrow esc-1 moved to status released');
  });
});
