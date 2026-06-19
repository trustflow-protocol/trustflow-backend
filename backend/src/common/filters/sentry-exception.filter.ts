import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import * as Sentry from '@sentry/node';
import { SentryService } from '../../sentry/sentry.service';

@Injectable()
@Catch()
export class SentryExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(SentryExceptionFilter.name);

  constructor(private readonly sentryService: SentryService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status: number;
    let message: string;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      message =
        typeof res === 'string'
          ? res
          : ((res as { message?: string }).message ?? exception.message);
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = 'Internal server error';
    }

    // Send 5xx errors and unexpected non-HTTP exceptions to Sentry
    const shouldCapture = !(exception instanceof HttpException) || status >= 500;
    if (shouldCapture) {
      Sentry.withScope(scope => {
        scope.setTag('url', request.url);
        scope.setTag('method', request.method);
        scope.setExtra('statusCode', status);
        scope.setUser({ ip_address: request.ip });
        this.sentryService.captureException(exception, 'SentryExceptionFilter');
      });
      this.logger.error(
        `[${request.method}] ${request.url} — ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json({
      statusCode: status,
      message,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
