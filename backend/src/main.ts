import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ValidationPipe, Logger } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import * as express from 'express';
import { AppModule } from './app.module';
import { SentryService } from './sentry/sentry.service';
import { SentryExceptionFilter } from './common/filters/sentry-exception.filter';
import { SorobanEventIndexerService } from './soroban-event-indexer/soroban-event-indexer.service';
import { MetricsHttpInterceptor } from './monitoring/metrics-http.interceptor';
import { CorrelationIdStore } from './common/logging/correlation-id.store';

const logger = new Logger('Bootstrap');

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

  // Explicit body-size limit for JSON payloads.
  // The IPFS pin endpoint accepts base64-encoded deliverable content; 10 MB decoded
  // encodes to ~13.6 MB base64, so a 15 MB JSON limit gives adequate headroom while
  // still providing a deliberate, reviewed DoS control rather than relying on Express's
  // implicit default.  Override via BODY_LIMIT_MB env var if your use case requires it.
  const bodyLimitMb = parseInt(process.env.BODY_LIMIT_MB || '15', 10);
  const bodyLimit = `${bodyLimitMb}mb`;
  app.use(express.json({ limit: bodyLimit }));
  app.use(express.urlencoded({ extended: true, limit: bodyLimit }));

  // Initialize Sentry via the injectable service so it shares the same instance
  const sentryService = app.get(SentryService);
  sentryService.init();

  // Register global exception filter — captures 5xx errors to Sentry, tags with correlationId
  const correlationIdStore = app.get(CorrelationIdStore);
  app.useGlobalFilters(new SentryExceptionFilter(sentryService, correlationIdStore));

  // Register global metrics interceptor
  const metricsInterceptor = app.get(MetricsHttpInterceptor);
  app.useGlobalInterceptors(metricsInterceptor);

  // Enable CORS
  const corsOrigin = process.env.CORS_ORIGIN;
  const nodeEnv = process.env.NODE_ENV || 'development';

  // Validate CORS configuration in production
  if (nodeEnv === 'production' && (!corsOrigin || corsOrigin === '*')) {
    logger.error(
      'CORS_ORIGIN must be explicitly set in production (cannot use wildcard with credentials: true)',
    );
    process.exit(1);
  }

  // Warn if using wildcard in any environment (but only fail in production)
  if (corsOrigin === '*' && nodeEnv === 'production') {
    logger.error(
      'Using wildcard CORS origin with credentials enabled is a security risk. Set CORS_ORIGIN to a comma-separated list of allowed origins.',
    );
    process.exit(1);
  }

  app.enableCors({
    origin: corsOrigin || '*',
    credentials: true,
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Swagger configuration
  const config = new DocumentBuilder()
    .setTitle('TrustFlow API')
    .setDescription(
      'The TrustFlow Backend API provides off-chain services for the TrustFlow gig economy platform. ' +
        'It handles authentication, escrow management, webhook dispatch, and Stellar blockchain integration.\n\n' +
        '**Wallet-Signature Authentication:** Challenge-response auth using Stellar wallet signatures. ' +
        'Challenges use single-use nonces with 60-second TTLs and are stored in a distributed Redis nonce store ' +
        'that blocks replay attacks across all API nodes. Note: several endpoints (e.g. Escrow, Webhooks) ' +
        'are currently unauthenticated and rely on IP-scoped rate limiting only — per-wallet limits do not ' +
        'apply to them. See individual endpoint docs for the applicable security model.\n\n' +
        '**Error Monitoring:** All 5xx errors and unhandled exceptions are automatically captured by Sentry ' +
        'for real-time alerting and triage. Set the `SENTRY_DSN` environment variable to enable.\n\n' +
        '**Rate Limiting:** Authenticated endpoints benefit from coordinated per-IP and per-wallet ' +
        'distributed token-bucket limits across API nodes. Unauthenticated endpoints receive IP-scoped ' +
        'limiting only (no wallet identity is available). Repeated limit violations are tracked in a ' +
        'sliding abuse window and can trigger temporary lockouts. When a request is rejected, the API ' +
        'returns `429 Too Many Requests` with `retryAfter` and `scope` fields. Health check (`/health`) ' +
        'and metrics (`/metrics`) endpoints are exempt from rate limiting. Requires `REDIS_URL` to be configured.\n\n' +
        '**Transactional Outbox:** Gig state changes and their domain events are committed in the same ' +
        'Redis MULTI/EXEC transaction. A background relay delivers each event at least once to the WebSocket ' +
        'gateway channel, worker queue, and registered webhooks. Consumers must deduplicate by `dedupKey`.',
    )
    .setVersion('1.0.0')
    .setContact('TrustFlow Protocol', 'https://trustflow.xyz', 'support@trustflow.xyz')
    .setLicense('MIT', 'https://opensource.org/licenses/MIT')
    .addServer(process.env.API_URL || 'http://localhost:3001', 'Development')
    .addServer('https://api.trustflow.xyz', 'Production')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Enter JWT token obtained from /auth/login endpoint',
      },
      'JWT-auth',
    )
    .addTag('Authentication', 'Wallet-based JWT authentication endpoints')
    .addTag(
      'Escrow',
      'Escrow vault management and dispute resolution. ' +
        'Note: these endpoints are currently unauthenticated — rate limiting is IP-scoped only.',
    )
    .addTag(
      'Webhooks',
      'Webhook registration and management. ' +
        'Note: register/unregister endpoints are currently unauthenticated — rate limiting is IP-scoped only.',
    )
    .addTag('Outbox', 'Durable at-least-once domain event delivery and relay operations')
    .addTag('Monitoring', 'Health checks and metrics')
    .addTag(
      'IPFS Pinning',
      'Multi-provider IPFS pinning with content-hash verification, automatic failover, and a ' +
        'background re-pin worker that restores replication when a provider silently drops a pin.',
    )
    .addTag(
      'Gigs',
      'Gig solicitation postings with a background sweep that automatically expires ' +
        'solicitations left unanswered past their response deadline.',
    )
    .addTag(
      'Admin',
      'Read-only system analytics for protocol admins — escrow, gig, dispute, reputation, ' +
        'migration, and reconciliation state aggregated into a dashboard view. Restricted to ' +
        'wallet addresses listed in `ADMIN_ADDRESSES`.',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);

  SwaggerModule.setup('api/docs', app, document, {
    customSiteTitle: 'TrustFlow API Documentation',
    customfavIcon: 'https://trustflow.xyz/favicon.ico',
    customCss: '.swagger-ui .topbar { display: none }',
    swaggerOptions: {
      persistAuthorization: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
    },
  });

  SwaggerModule.setup('api/docs-json', app, document, {
    jsonDocumentUrl: '/api/docs-json',
  });

  // Start Soroban event indexer
  const indexer = app.get(SorobanEventIndexerService);
  indexer.start();

  const port = process.env.PORT || 3001;
  await app.listen(port);

  logger.log(`🚀 TrustFlow API running on: http://localhost:${port}`);
  logger.log(`📚 API Documentation: http://localhost:${port}/api/docs`);
  logger.log(`📄 OpenAPI JSON: http://localhost:${port}/api/docs-json`);
  if (sentryService.isInitialized()) {
    logger.log('🔍 Sentry error monitoring active');
  }
}

bootstrap();
