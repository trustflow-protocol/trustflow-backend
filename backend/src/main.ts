import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

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
        'It handles authentication, escrow management, webhook dispatch, and Stellar blockchain integration.',
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

  // Serve Swagger UI at /api/docs
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

  // Also expose raw OpenAPI JSON
  SwaggerModule.setup('api/docs-json', app, document, {
    jsonDocumentUrl: '/api/docs-json',
  });

  const port = process.env.PORT || 3001;
  await app.listen(port);

  console.log(`🚀 TrustFlow API running on: http://localhost:${port}`);
  console.log(`📚 API Documentation: http://localhost:${port}/api/docs`);
  console.log(`📄 OpenAPI JSON: http://localhost:${port}/api/docs-json`);
}

bootstrap();
