import { Horizon } from '@stellar/stellar-sdk';
import { StellarService } from './stellar.service';
import type { RpcFailoverService } from './rpc-failover.service';

// Only isAddressActive() is covered here, per #441 (the wider StellarService
// spec — getBalance, withFailover retry/failover semantics — is tracked
// separately in #397).
describe('StellarService', () => {
  let service: StellarService;
  let mockRpcFailoverService: jest.Mocked<RpcFailoverService>;

  beforeEach(() => {
    mockRpcFailoverService = {
      getCurrentHorizonEndpoint: jest.fn().mockReturnValue('https://horizon-testnet.stellar.org'),
    } as unknown as jest.Mocked<RpcFailoverService>;

    service = new StellarService(mockRpcFailoverService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('isAddressActive', () => {
    it('returns true when loadAccount succeeds', async () => {
      jest.spyOn(Horizon.Server.prototype, 'loadAccount').mockResolvedValue({} as never);

      await expect(service.isAddressActive('GVALID')).resolves.toBe(true);
    });

    it('returns false on a genuine Horizon 404 (account not found)', async () => {
      jest
        .spyOn(Horizon.Server.prototype, 'loadAccount')
        .mockRejectedValue({ response: { status: 404 }, message: 'Not Found' });

      await expect(service.isAddressActive('GUNFUNDED')).resolves.toBe(false);
    });

    it('rethrows on a Horizon 500 instead of reporting inactive', async () => {
      jest
        .spyOn(Horizon.Server.prototype, 'loadAccount')
        .mockRejectedValue({ response: { status: 500 }, message: 'Internal Server Error' });

      await expect(service.isAddressActive('GADDR')).rejects.toBeTruthy();
    });

    it('rethrows on a network/timeout error instead of reporting inactive', async () => {
      jest.spyOn(Horizon.Server.prototype, 'loadAccount').mockRejectedValue(new Error('ETIMEDOUT'));

      await expect(service.isAddressActive('GADDR')).rejects.toThrow('ETIMEDOUT');
    });

    it('retries (via withFailover) on a transient error before giving up', async () => {
      const loadAccountSpy = jest
        .spyOn(Horizon.Server.prototype, 'loadAccount')
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce({} as never);

      const result = await service.isAddressActive('GADDR');

      expect(result).toBe(true);
      expect(loadAccountSpy).toHaveBeenCalledTimes(2);
    });
  });
});
