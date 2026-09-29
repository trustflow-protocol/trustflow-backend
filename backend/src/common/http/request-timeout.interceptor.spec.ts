import { Test, TestingModule } from '@nestjs/testing';
import { RequestTimeoutInterceptor } from './request-timeout.interceptor';
import { ExecutionContext, CallHandler, RequestTimeoutException, Reflector } from '@nestjs/common';
import { of, delay, throwError } from 'rxjs';
import { setTestEnv, resetEnvConfig } from '../../config/env.config';

describe('RequestTimeoutInterceptor', () => {
  let interceptor: RequestTimeoutInterceptor;
  let reflector: Reflector;

  beforeEach(async () => {
    // Reset env config to use test defaults
    resetEnvConfig();
    setTestEnv({ REQUEST_TIMEOUT_MS: '500' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [RequestTimeoutInterceptor, Reflector],
    }).compile();

    interceptor = module.get<RequestTimeoutInterceptor>(RequestTimeoutInterceptor);
    reflector = module.get<Reflector>(Reflector);
  });

  afterEach(() => {
    resetEnvConfig();
  });

  it('should be defined', () => {
    expect(interceptor).toBeDefined();
  });

  describe('timeout enforcement', () => {
    it('should allow requests that complete within the timeout', done => {
      const mockRequest = { method: 'GET', path: '/api/test' };
      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => mockRequest,
        }),
        getHandler: () => () => {},
        getClass: () => class {},
      } as unknown as ExecutionContext;

      const mockCallHandler: CallHandler = {
        handle: () => of({ data: 'success' }).pipe(delay(100)),
      };

      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);

      interceptor.intercept(mockContext, mockCallHandler).subscribe(result => {
        expect(result).toEqual({ data: 'success' });
        done();
      });
    });

    it('should throw RequestTimeoutException when timeout is exceeded', done => {
      const mockRequest = { method: 'GET', path: '/api/slow' };
      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => mockRequest,
        }),
        getHandler: () => () => {},
        getClass: () => class {},
      } as unknown as ExecutionContext;

      const mockCallHandler: CallHandler = {
        handle: () => of({}).pipe(delay(1000)),
      };

      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);

      interceptor.intercept(mockContext, mockCallHandler).subscribe({
        next: () => {
          fail('Should have thrown RequestTimeoutException');
        },
        error: (error: unknown) => {
          expect(error).toBeInstanceOf(RequestTimeoutException);
          expect((error as RequestTimeoutException).getStatus()).toBe(408);
          done();
        },
      });
    });
  });

  describe('route exemptions', () => {
    it('should exempt /health routes', done => {
      const mockRequest = { method: 'GET', path: '/health' };
      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => mockRequest,
        }),
        getHandler: () => () => {},
        getClass: () => class {},
      } as unknown as ExecutionContext;

      const mockCallHandler: CallHandler = {
        handle: () => of({}).pipe(delay(1000)),
      };

      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);

      // Should not timeout even though delay > timeout
      interceptor.intercept(mockContext, mockCallHandler).subscribe(result => {
        expect(result).toBeDefined();
        done();
      });
    });

    it('should exempt /health/live prefix routes', done => {
      const mockRequest = { method: 'GET', path: '/health/live' };
      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => mockRequest,
        }),
        getHandler: () => () => {},
        getClass: () => class {},
      } as unknown as ExecutionContext;

      const mockCallHandler: CallHandler = {
        handle: () => of({}).pipe(delay(1000)),
      };

      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);

      interceptor.intercept(mockContext, mockCallHandler).subscribe(result => {
        expect(result).toBeDefined();
        done();
      });
    });

    it('should exempt /metrics routes', done => {
      const mockRequest = { method: 'GET', path: '/metrics' };
      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => mockRequest,
        }),
        getHandler: () => () => {},
        getClass: () => class {},
      } as unknown as ExecutionContext;

      const mockCallHandler: CallHandler = {
        handle: () => of({}).pipe(delay(1000)),
      };

      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);

      interceptor.intercept(mockContext, mockCallHandler).subscribe(result => {
        expect(result).toBeDefined();
        done();
      });
    });

    it('should exempt /api/docs routes', done => {
      const mockRequest = { method: 'GET', path: '/api/docs' };
      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => mockRequest,
        }),
        getHandler: () => () => {},
        getClass: () => class {},
      } as unknown as ExecutionContext;

      const mockCallHandler: CallHandler = {
        handle: () => of({}).pipe(delay(1000)),
      };

      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);

      interceptor.intercept(mockContext, mockCallHandler).subscribe(result => {
        expect(result).toBeDefined();
        done();
      });
    });
  });

  describe('decorator overrides', () => {
    it('should fully exempt routes with @SkipTimeout()', done => {
      const mockRequest = { method: 'GET', path: '/api/test' };
      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => mockRequest,
        }),
        getHandler: () => () => {},
        getClass: () => class {},
      } as unknown as ExecutionContext;

      const mockCallHandler: CallHandler = {
        handle: () => of({}).pipe(delay(1000)),
      };

      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);

      interceptor.intercept(mockContext, mockCallHandler).subscribe(result => {
        expect(result).toBeDefined();
        done();
      });
    });

    it('should apply custom timeout from @SkipTimeout(ms)', done => {
      const mockRequest = { method: 'POST', path: '/ipfs/pins' };
      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => mockRequest,
        }),
        getHandler: () => () => {},
        getClass: () => class {},
      } as unknown as ExecutionContext;

      const mockCallHandler: CallHandler = {
        handle: () => of({}).pipe(delay(600)),
      };

      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(2000);

      interceptor.intercept(mockContext, mockCallHandler).subscribe(result => {
        expect(result).toBeDefined();
        done();
      });
    });

    it('should timeout with custom timeout from @SkipTimeout(ms)', done => {
      const mockRequest = { method: 'POST', path: '/ipfs/pins' };
      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => mockRequest,
        }),
        getHandler: () => () => {},
        getClass: () => class {},
      } as unknown as ExecutionContext;

      const mockCallHandler: CallHandler = {
        handle: () => of({}).pipe(delay(2000)),
      };

      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(500);

      interceptor.intercept(mockContext, mockCallHandler).subscribe({
        next: () => {
          fail('Should have thrown RequestTimeoutException');
        },
        error: (error: unknown) => {
          expect(error).toBeInstanceOf(RequestTimeoutException);
          done();
        },
      });
    });
  });

  describe('error propagation', () => {
    it('should propagate non-timeout errors', done => {
      const mockRequest = { method: 'GET', path: '/api/test' };
      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => mockRequest,
        }),
        getHandler: () => () => {},
        getClass: () => class {},
      } as unknown as ExecutionContext;

      const testError = new Error('Test error');
      const mockCallHandler: CallHandler = {
        handle: () => throwError(() => testError),
      };

      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);

      interceptor.intercept(mockContext, mockCallHandler).subscribe({
        next: () => {
          fail('Should have thrown the test error');
        },
        error: (error: unknown) => {
          expect(error).toBe(testError);
          done();
        },
      });
    });
  });
});
