import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { SentryExceptionFilter } from './sentry-exception.filter';
import { SentryService } from '../../sentry/sentry.service';

jest.mock('@sentry/node', () => ({
  captureException: jest.fn(),
  withScope: jest.fn((cb: (scope: unknown) => unknown) => {
    const scope = { setTag: jest.fn(), setExtra: jest.fn(), setUser: jest.fn() };
    return cb(scope);
  }),
}));

function buildHost(url = '/test', method = 'GET', ip = '127.0.0.1') {
  const response = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
  const request = { url, method, ip };
  return {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
    response,
    request,
  } as unknown as ArgumentsHost;
}

describe('SentryExceptionFilter', () => {
  let filter: SentryExceptionFilter;
  let sentryService: jest.Mocked<SentryService>;

  beforeEach(() => {
    jest.clearAllMocks();
    sentryService = {
      captureException: jest.fn().mockReturnValue('evt-id'),
      isInitialized: jest.fn().mockReturnValue(true),
    } as unknown as jest.Mocked<SentryService>;
    filter = new SentryExceptionFilter(sentryService);
  });

  it('should be defined', () => {
    expect(filter).toBeDefined();
  });

  describe('HttpException — 4xx (client errors)', () => {
    it('should respond with 404 status and NOT capture to Sentry', () => {
      const host = buildHost();
      const exception = new HttpException('Not Found', HttpStatus.NOT_FOUND);
      filter.catch(exception, host);

      const { response } = host as unknown as { response: { status: jest.Mock; json: jest.Mock } };
      expect(response.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
      expect(sentryService.captureException).not.toHaveBeenCalled();
    });

    it('should respond with 400 and NOT send to Sentry', () => {
      const host = buildHost();
      const exception = new HttpException('Bad Request', HttpStatus.BAD_REQUEST);
      filter.catch(exception, host);

      const { response } = host as unknown as { response: { status: jest.Mock; json: jest.Mock } };
      expect(response.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      expect(sentryService.captureException).not.toHaveBeenCalled();
    });
  });

  describe('HttpException — 5xx (server errors)', () => {
    it('should respond with 500 and capture to Sentry', () => {
      const host = buildHost();
      const exception = new HttpException('Internal Error', HttpStatus.INTERNAL_SERVER_ERROR);
      filter.catch(exception, host);

      const { response } = host as unknown as { response: { status: jest.Mock; json: jest.Mock } };
      expect(response.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(sentryService.captureException).toHaveBeenCalled();
    });
  });

  describe('Unknown / non-HTTP exceptions', () => {
    it('should respond with 500 and capture to Sentry for plain Error', () => {
      const host = buildHost('/api/escrow', 'POST');
      const exception = new Error('Unexpected DB failure');
      filter.catch(exception, host);

      const { response } = host as unknown as { response: { status: jest.Mock; json: jest.Mock } };
      expect(response.status).toHaveBeenCalledWith(500);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 500,
          message: 'Internal server error',
          path: '/api/escrow',
        }),
      );
      expect(sentryService.captureException).toHaveBeenCalled();
    });

    it('should handle thrown strings gracefully', () => {
      const host = buildHost();
      filter.catch('something broke', host);

      const { response } = host as unknown as { response: { status: jest.Mock; json: jest.Mock } };
      expect(response.status).toHaveBeenCalledWith(500);
      expect(sentryService.captureException).toHaveBeenCalled();
    });
  });

  describe('response shape', () => {
    it('should include timestamp and path in error response', () => {
      const host = buildHost('/api/auth/login', 'POST');
      filter.catch(new Error('crash'), host);

      const { response } = host as unknown as { response: { status: jest.Mock; json: jest.Mock } };
      const body = response.json.mock.calls[0][0];
      expect(body).toHaveProperty('timestamp');
      expect(body).toHaveProperty('path', '/api/auth/login');
      expect(body).toHaveProperty('statusCode', 500);
    });
  });
});
