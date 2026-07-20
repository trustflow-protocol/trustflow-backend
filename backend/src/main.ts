import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ValidationPipe, Logger } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { AppModule } from './app.module';
import { SentryService } from './sentry/sentry.service';
import { SentryExceptionFilter } from './common/filters/sentry-exception.filter';

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

  // Initialize Sentry via the injectable service so it shares the same instance
  const sentryService = app.get(SentryService);
  sentryService.init();

  // Register global exception filter — captures 5xx errors to Sentry
  app.useGlobalFilters(new SentryExceptionFilter(sentryService));

  // Enable CORS
  app.enableCors({
    origin: process.env.CORS_ORIGIN || '*',
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
        '**Error Monitoring:** All 5xx errors and unhandled exceptions are automatically captured by Sentry ' +
        'for real-time alerting and triage. Set the `SENTRY_DSN` environment variable to enable.\n\n' +
        '**Rate Limiting:** All endpoints use a Redis-backed distributed token bucket with coordinated ' +
        'per-IP and per-wallet limits across API nodes. Repeated limit violations are tracked in a sliding ' +
        'abuse window and can trigger temporary lockouts. When a request is rejected, the API returns ' +
        '`429 Too Many Requests` with `retryAfter` and `scope` fields. Health check (`/health`) and metrics ' +
        '(`/metrics`) endpoints are exempt from rate limiting. Requires `REDIS_URL` to be configured.',
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
    .addTag('Escrow', 'Escrow vault management and dispute resolution')
    .addTag('Webhooks', 'Webhook registration and management')
    .addTag('Monitoring', 'Health checks and metrics')
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
