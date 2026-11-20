import { AuditService } from './audit.service';
import { requestContextStorage } from '../common/logging/request-context';

describe('AuditService impersonation attribution (#944)', () => {
  const entry = { operation: 'escrow.release', user: 'GUSER', entityId: 'e1', entityType: 'escrow' };

  function setup() {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const db = { isConfigured: true, getPool: () => ({ query }) };
    return { service: new AuditService(db as any), query };
  }

  it('records the originating admin alongside the impersonated wallet', async () => {
    const { service, query } = setup();
    const request = { user: { address: 'GUSER', sub: 'GUSER', impersonatedBy: 'GADMIN' } };

    await requestContextStorage.run({ requestId: 'r1', request: request as any }, () =>
      service.logOperation({ ...entry, metadata: { reason: 'support' } }),
    );

    const params = query.mock.calls[0][1];
    expect(params[1]).toBe('GUSER');
    expect(JSON.parse(params[6])).toEqual({ reason: 'support', impersonatedBy: 'GADMIN' });
  });

  it('leaves metadata unchanged outside an impersonation session', async () => {
    const { service, query } = setup();
    await requestContextStorage.run({ requestId: 'r2', request: { user: { address: 'GUSER' } } as any }, () =>
      service.logOperation(entry),
    );
    expect(query.mock.calls[0][1][6]).toBeNull();
  });
});
