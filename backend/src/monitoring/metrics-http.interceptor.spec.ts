import { Test, TestingModule } from '@nestjs/testing';
import { MetricsHttpInterceptor } from './metrics-http.interceptor';
import { MetricsService } from './metrics.service';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of, throwError } from 'rxjs';

describe('MetricsHttpInterceptor', () => {
  let interceptor: MetricsHttpInterceptor;
  let metricsService: MetricsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MetricsHttpInterceptor, MetricsService],
    }).compile();

    interceptor = module.get<MetricsHttpInterceptor>(MetricsHttpInterceptor);
    metricsService = module.get<MetricsService>(MetricsService);
  });

  it('should be defined', () => {
    expect(interceptor).toBeDefined();
  });

  describe('intercept', () => {
    it('should track successful HTTP requests', (done) => {
      const incrementSpy = jest.spyOn(metricsService, 'increment');

      const mockRequest = {
        method: 'GET',
        originalUrl: '/api/users',
      };

      const mockResponse = {
        statusCode: 200,
      };

      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => mockRequest,
          getResponse: () => mockResponse,
        }),
      } as ExecutionContext;

      const mockCallHandler: CallHandler = {
        handle: () => of({}),
      };

      interceptor.intercept(mockContext, mockCallHandler).subscribe(() => {
        // Should have incremented http_requests_total
        expect(incrementSpy).toHaveBeenCalledWith('http_requests_total', {
          method: 'GET',
          route: '/api/users',
        });

        // Should have incremented http_request_duration_seconds
        expect(incrementSpy).toHaveBeenCalledWith(
          'http_request_duration_seconds',
          expect.objectContaining({
            route: '/api/users',
            status_code: '200',
          }),
        );

        // Should have incremented http_requests_success_total
        expect(incrementSpy).toHaveBeenCalledWith('http_requests_success_total', {
          method: 'GET',
          route: '/api/users',
          status_code: '200',
        });

        done();
      });
    });

    it('should track failed HTTP requests', (done) => {
      const incrementSpy = jest.spyOn(metricsService, 'increment');

      const mockRequest = {
        method: 'POST',
        originalUrl: '/api/users/123',
      };

      const mockResponse = {
        statusCode: 500,
      };

      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => mockRequest,
          getResponse: () => mockResponse,
        }),
      } as ExecutionContext;

      const mockError = new Error('Internal Server Error');
      (mockError as any).status = 500;

      const mockCallHandler: CallHandler = {
        handle: () => throwError(() => mockError),
      };

      interceptor.intercept(mockContext, mockCallHandler).subscribe({
        error: () => {
          // Should have incremented http_requests_total
          expect(incrementSpy).toHaveBeenCalledWith('http_requests_total', {
            method: 'POST',
            route: '/api/users/:id',
          });

          // Should have incremented http_requests_errors_total
          expect(incrementSpy).toHaveBeenCalledWith(
            'http_requests_errors_total',
            expect.objectContaining({
              method: 'POST',
              route: '/api/users/:id',
              status_code: '500',
            }),
          );

          done();
        },
      });
    });

    it('should normalize dynamic route parameters', (done) => {
      const incrementSpy = jest.spyOn(metricsService, 'increment');

      const mockRequest = {
        method: 'GET',
        originalUrl: '/api/escrows/esc-abc123/release/transaction',
      };

      const mockResponse = {
        statusCode: 200,
      };

      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => mockRequest,
          getResponse: () => mockResponse,
        }),
      } as ExecutionContext;

      const mockCallHandler: CallHandler = {
        handle: () => of({}),
      };

      interceptor.intercept(mockContext, mockCallHandler).subscribe(() => {
        // Should normalize the ID to :id
        expect(incrementSpy).toHaveBeenCalledWith('http_requests_total', {
          method: 'GET',
          route: expect.stringContaining('/api/escrows'),
        });

        done();
      });
    });

    it('should remove query strings from routes', (done) => {
      const incrementSpy = jest.spyOn(metricsService, 'increment');

      const mockRequest = {
        method: 'GET',
        originalUrl: '/api/users?page=1&limit=10',
      };

      const mockResponse = {
        statusCode: 200,
      };

      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => mockRequest,
          getResponse: () => mockResponse,
        }),
      } as ExecutionContext;

      const mockCallHandler: CallHandler = {
        handle: () => of({}),
      };

      interceptor.intercept(mockContext, mockCallHandler).subscribe(() => {
        // Should not include query string
        expect(incrementSpy).toHaveBeenCalledWith('http_requests_total', {
          method: 'GET',
          route: '/api/users',
        });

        done();
      });
    });
  });

  describe('metrics output', () => {
    it('should output non-empty metrics after requests', (done) => {
      const mockRequest = {
        method: 'GET',
        originalUrl: '/api/users',
      };

      const mockResponse = {
        statusCode: 200,
      };

      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => mockRequest,
          getResponse: () => mockResponse,
        }),
      } as ExecutionContext;

      const mockCallHandler: CallHandler = {
        handle: () => of({}),
      };

      interceptor.intercept(mockContext, mockCallHandler).subscribe(() => {
        const metrics = metricsService.toPrometheus();
        expect(metrics).toBeTruthy();
        expect(metrics.length).toBeGreaterThan(0);
        expect(metrics).toContain('http_requests_total');
        expect(metrics).toContain('http_request_duration_seconds');
        expect(metrics).toContain('http_requests_success_total');
        done();
      });
    });
  });
});
