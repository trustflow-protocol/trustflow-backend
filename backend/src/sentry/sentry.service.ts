import { Injectable } from '@nestjs/common';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import { redactIp, redactString, redactUrl, redactValue } from '../common/logging/redaction';
import * as Sentry from '@sentry/node';
import { config } from '../config/env.config';

@Injectable()
export class SentryService {
  private readonly logger = new SanitizedLogger(SentryService.name);
  private initialized = false;

  init(): void {
    const dsn = config.SENTRY_DSN;
    const isProduction = config.NODE_ENV === 'production';

    if (!dsn) {
      this.logger.warn('SENTRY_DSN not set — Sentry error reporting disabled.');
      return;
    }

    Sentry.init({
      dsn,
      environment: config.NODE_ENV,
      release: config.APP_RELEASE,
      tracesSampleRate: isProduction ? 0.2 : 1.0,
      enabled: !!dsn,
      // The SDK types `beforeSend` against `ErrorEvent`, but `scrubEvent` is declared over the
      // `Event` base because every field it touches lives there. Widening the parameter and
      // narrowing the return keeps the cast one-directional and reviewable.
      beforeSend: (event: Sentry.Event) => scrubEvent(event) as never,
    });

    this.initialized = true;
    this.logger.log(`Sentry initialized (env: ${config.NODE_ENV})`);
  }

  captureException(exception: unknown, context?: string): string {
    if (!this.initialized) return '';
    return Sentry.withScope(scope => {
      if (context) scope.setTag('context', context);
      return Sentry.captureException(exception);
    });
  }

  captureMessage(message: string, level: Sentry.SeverityLevel = 'info'): string {
    if (!this.initialized) return '';
    return Sentry.captureMessage(message, level);
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}

/**
 * Strips sensitive data from an outbound Sentry event.
 *
 * Without this, anything that ended up inside an `Error` message or stack — a pg error
 * carrying row values, a webhook URL containing a token, a request URL carrying a query-string
 * credential — was transmitted verbatim to the third party and retained there under its own
 * retention policy. The exception object is the one payload that the app's own logging layer
 * cannot intercept before it leaves the process, so it has to be scrubbed at the boundary.
 *
 * Applies the same key- and value-based policy as `src/common/logging/redaction.ts`, plus a
 * dedicated pass for the `url` tag the exception filter attaches (path + query string).
 */
export function scrubEvent(event: Sentry.Event): Sentry.Event {
  const scrubbed = { ...event } as Sentry.Event & Record<string, unknown>;

  if (typeof scrubbed.message === 'string') {
    scrubbed.message = redactString(scrubbed.message);
  }

  if (scrubbed.tags) {
    const tags: Record<string, string> = {};
    for (const [key, value] of Object.entries(scrubbed.tags)) {
      const asString = String(value ?? '');
      tags[key] = key === 'url' ? redactUrl(asString) : redactString(asString);
    }
    scrubbed.tags = tags;
  }

  if (scrubbed.extra && typeof scrubbed.extra === 'object') {
    scrubbed.extra = redactValue(scrubbed.extra) as Record<string, unknown>;
  }

  if (scrubbed.contexts && typeof scrubbed.contexts === 'object') {
    scrubbed.contexts = redactValue(scrubbed.contexts) as Sentry.Event['contexts'];
  }

  if (scrubbed.user && typeof scrubbed.user === 'object') {
    // The filter only ever sets the IP; keep the reduction consistent with the logs.
    const user = scrubbed.user;
    if (typeof user.ip_address === 'string') {
      user.ip_address = redactIp(user.ip_address);
    }
  }

  // `exception.values[].value` duplicates the message on some SDK versions; the stack frames
  // themselves carry only module/function names, so they need no scrubbing.
  for (const value of scrubbed.exception?.values ?? []) {
    if (typeof value.value === 'string') value.value = redactString(value.value);
  }

  return scrubbed;
}
