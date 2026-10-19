import { ArgumentsHost, HttpStatus, ValidationPipe } from '@nestjs/common';
import { z } from 'zod';
import { SentryExceptionFilter } from '../filters/sentry-exception.filter';
import { SentryService } from '../../sentry/sentry.service';
import { CreateEscrowSchema } from '../../escrow/escrow.dto';
import { VerifyDto } from '../../auth/dto/verify.dto';
import { classValidatorExceptionFactory, zodErrorToFieldErrors } from './validation-error';

jest.mock('@sentry/node', () => ({
  captureException: jest.fn(),
  withScope: jest.fn((cb: (scope: unknown) => unknown) =>
    cb({ setTag: jest.fn(), setExtra: jest.fn(), setUser: jest.fn() }),
  ),
}));

function buildHost() {
  const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const request = { url: '/v1/test', method: 'POST', ip: '127.0.0.1' };
  return {
    host: {
      switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
    } as unknown as ArgumentsHost,
    response,
  };
}

/** #368 — both validation paths must produce the same field-level 400. */
describe('validation error contract (#368)', () => {
  let filter: SentryExceptionFilter;
  let sentryService: jest.Mocked<SentryService>;

  beforeEach(() => {
    sentryService = {
      captureException: jest.fn(),
      isInitialized: jest.fn().mockReturnValue(true),
    } as unknown as jest.Mocked<SentryService>;
    filter = new SentryExceptionFilter(sentryService);
  });

  async function classValidatorFailure(body: unknown): Promise<unknown> {
    const pipe = new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      exceptionFactory: classValidatorExceptionFactory,
    });
    try {
      await pipe.transform(body, { type: 'body', metatype: VerifyDto });
    } catch (error) {
      return error;
    }
    throw new Error('expected validation to fail');
  }

  function zodFailure(body: unknown): unknown {
    try {
      CreateEscrowSchema.parse(body);
    } catch (error) {
      return error;
    }
    throw new Error('expected validation to fail');
  }

  it('maps a ZodError to a 400 naming each field, without reporting it to Sentry', () => {
    const { host, response } = buildHost();

    filter.catch(zodFailure({}), host);

    expect(response.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    const body = response.json.mock.calls[0][0];
    expect(body).toMatchObject({ statusCode: 400, message: 'Validation failed' });
    expect(body.errors.length).toBeGreaterThan(0);
    for (const entry of body.errors) {
      expect(entry).toEqual({ field: expect.any(String), message: expect.any(String) });
    }
    expect(sentryService.captureException).not.toHaveBeenCalled();
  });

  it('returns the same shape for a class-validator failure', async () => {
    const { host, response } = buildHost();

    filter.catch(await classValidatorFailure({ signature: 'abc' }), host);

    expect(response.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    const body = response.json.mock.calls[0][0];
    expect(body).toMatchObject({ statusCode: 400, message: 'Validation failed' });
    expect(body.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'address' })]),
    );
    expect(sentryService.captureException).not.toHaveBeenCalled();
  });

  it('both paths expose identical top-level keys', async () => {
    const zod = buildHost();
    const cv = buildHost();
    filter.catch(zodFailure({}), zod.host);
    filter.catch(await classValidatorFailure({}), cv.host);

    const keys = (r: typeof zod.response) => Object.keys(r.json.mock.calls[0][0]).sort();
    expect(keys(zod.response)).toEqual(keys(cv.response));
  });

  it('reports nested Zod paths with dots', () => {
    const schema = z.object({ items: z.array(z.object({ amount: z.number() })) });
    const result = schema.safeParse({ items: [{ amount: 'x' }] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(zodErrorToFieldErrors(result.error)[0].field).toBe('items.0.amount');
    }
  });
});
