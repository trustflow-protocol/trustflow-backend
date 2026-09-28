import { Logger, LoggerService } from '@nestjs/common';
import { redactError, redactString, redactValue } from './redaction';

/**
 * A {@link Logger} that redacts sensitive data from every argument before it reaches the
 * underlying transport.
 *
 * This is the enforcement point for the "logs are production-safe" requirement. Redaction
 * cannot be left to individual call sites — a developer adding `this.logger.log(body)` has to
 * remember to sanitise it, and the codebase already had dozens of log statements that
 * interpolated a request body, a webhook URL, or a raw `Error` without doing so. Sanitising at
 * the logger instead means a new call site is safe by construction.
 *
 * Only the string/serialisation paths need overriding: `Logger` accepts strings, and the
 * `...optionalParams` form exists so stack traces and objects can be passed positionally.
 * Those are scrubbed here rather than forwarded.
 */
export class SanitizedLogger implements LoggerService {
  constructor(private readonly context?: string) {}

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.delegate('log', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.delegate('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.delegate('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.delegate('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.delegate('verbose', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.delegate('fatal', message, optionalParams);
  }

  /**
   * Flattens an arbitrary message to a redacted string. Nest's `Logger` stringifies objects
   * itself, which would otherwise emit a raw request body — so objects are serialised here,
   * with the key-based redaction applied, and only then handed on as text.
   */
  private sanitise(message: unknown): string {
    if (typeof message === 'string') return redactString(message);
    if (message instanceof Error) return redactError(message);
    if (message === undefined) return 'undefined';
    if (message === null) return 'null';
    try {
      return JSON.stringify(redactValue(message)) ?? String(message);
    } catch {
      // Circular or otherwise unserialisable — fall back to the type rather than risking
      // an exception inside the logger itself.
      return `[unserialisable ${typeof message}]`;
    }
  }

  private delegate(
    level: 'log' | 'error' | 'warn' | 'debug' | 'verbose' | 'fatal',
    message: unknown,
    optionalParams: unknown[],
  ): void {
    // Nest's signature is (message, ...params) where the first param may be a stack trace
    // and the last may be the context string. Rebuild the call with sanitised arguments
    // while preserving arity, so a trailing context is not mistaken for a stack.
    const sanitisedParams = optionalParams.map(param => {
      if (typeof param === 'string') return redactString(param);
      if (param instanceof Error) return redactError(param);
      return this.sanitise(param);
    });

    const target = new Logger(this.context ?? '');
    target[level](this.sanitise(message), ...sanitisedParams);
  }
}
