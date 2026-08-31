import { Global, Module } from '@nestjs/common';
import { CorrelationIdStore } from './correlation-id.store';
import { CorrelationIdMiddleware } from './correlation-id.middleware';

/**
 * Provides the `CorrelationIdStore` and `CorrelationIdMiddleware` globally so any module can
 * inject `CorrelationIdStore` to read the current request's correlation ID.
 */
@Global()
@Module({
  providers: [CorrelationIdStore, CorrelationIdMiddleware],
  exports: [CorrelationIdStore, CorrelationIdMiddleware],
})
export class LoggingModule {}
