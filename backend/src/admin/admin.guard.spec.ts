import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AdminGuard } from './admin.guard';

function contextWithAddress(address: string | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user: address === undefined ? undefined : { address } }),
    }),
  } as unknown as ExecutionContext;
}

describe('AdminGuard', () => {
  const ORIGINAL_ADMIN_ADDRESSES = process.env.ADMIN_ADDRESSES;

  afterEach(() => {
    if (ORIGINAL_ADMIN_ADDRESSES === undefined) {
      delete process.env.ADMIN_ADDRESSES;
    } else {
      process.env.ADMIN_ADDRESSES = ORIGINAL_ADMIN_ADDRESSES;
    }
  });

  it('allows a caller whose address is in ADMIN_ADDRESSES', () => {
    process.env.ADMIN_ADDRESSES = 'GADMIN1,GADMIN2';
    const guard = new AdminGuard();

    expect(guard.canActivate(contextWithAddress('GADMIN2'))).toBe(true);
  });

  it('trims whitespace around each configured address', () => {
    process.env.ADMIN_ADDRESSES = ' GADMIN1 , GADMIN2 ';
    const guard = new AdminGuard();

    expect(guard.canActivate(contextWithAddress('GADMIN2'))).toBe(true);
  });

  it('rejects a caller whose address is not in ADMIN_ADDRESSES', () => {
    process.env.ADMIN_ADDRESSES = 'GADMIN1';
    const guard = new AdminGuard();

    expect(() => guard.canActivate(contextWithAddress('GNOTADMIN'))).toThrow(ForbiddenException);
  });

  it('rejects an unauthenticated caller', () => {
    process.env.ADMIN_ADDRESSES = 'GADMIN1';
    const guard = new AdminGuard();

    expect(() => guard.canActivate(contextWithAddress(undefined))).toThrow(ForbiddenException);
  });

  it('rejects every caller when ADMIN_ADDRESSES is unset (deny by default)', () => {
    delete process.env.ADMIN_ADDRESSES;
    const guard = new AdminGuard();

    expect(() => guard.canActivate(contextWithAddress('GANYONE'))).toThrow(ForbiddenException);
  });
});
