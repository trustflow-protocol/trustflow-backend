import './config/load-dotenv.bootstrap';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { AppModule } from './app.module';
import { SentryService } from './sentry/sentry.service';
import { configureApp } from './app.setup';
import { validateEnv, config } from './config/env.config';

const logger = new Logger('Bootstrap');

// Validate environment variables at startup before anything else runs.
// This fails fast with a clear error if required variables are missing or malformed,
// rather than allowing the app to start with invalid config that only surfaces as
// runtime errors later.
try {
  validateEnv();
  logger.log('✓ Environment variables validated successfully');
} catch (error) {
  logger.error('Environment variable validation failed:');
  logger.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

// Capture unhandled promise rejections before the app is ready
process.on('unhandledRejection', (reason: unknown) => {
  Sentry.captureException(reason);
  logger.error(
    'Unhandled Promise Rejection',
    reason instanceof Error ? reason.stack : String(reason),
  );
});

// Capture uncaught synchronous exceptions and exit
process.on('uncaughtException', (error: Error) => {
  Sentry.captureException(error);
  logger.error('Uncaught Exception — shutting down', error.stack);
  process.exit(1);
});

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  configureApp(app);

  const port = config.PORT;
  await app.listen(port);

  logger.log(`🚀 TrustFlow API running on: http://localhost:${port}`);
  logger.log(`📚 API Documentation: http://localhost:${port}/api/docs`);
  logger.log(`📄 OpenAPI JSON: http://localhost:${port}/api/docs-json`);
  if (app.get(SentryService).isInitialized()) {
    logger.log('🔍 Sentry error monitoring active');
  }
}

bootstrap();
