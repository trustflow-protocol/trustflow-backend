import { Injectable, Logger } from '@nestjs/common';
import * as Sentry from '@sentry/node';

@Injectable()
export class SentryService {
  private readonly logger = new Logger(SentryService.name);
  private initialized = false;

  init(): void {
    const dsn = process.env.SENTRY_DSN;
    const isProduction = process.env.NODE_ENV === 'production';

    if (!dsn) {
      this.logger.warn('SENTRY_DSN not set — Sentry error reporting disabled.');
      return;
    }

    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV ?? 'development',
      release: process.env.npm_package_version,
      tracesSampleRate: isProduction ? 0.2 : 1.0,
      enabled: !!dsn,
    });

    this.initialized = true;
    this.logger.log(`Sentry initialized (env: ${process.env.NODE_ENV ?? 'development'})`);
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
