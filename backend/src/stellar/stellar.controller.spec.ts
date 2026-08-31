import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StellarController } from './stellar.controller';
import { StellarAccountNotFoundError, StellarService } from './stellar.service';

const VALID = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';

describe('StellarController (#221)', () => {
  let stellar: jest.Mocked<Pick<StellarService, 'getBalance' | 'getLatestLedger'>>;
  let controller: StellarController;

  beforeEach(() => {
    stellar = {
      getBalance: jest.fn(),
      getLatestLedger: jest.fn(),
    };
    controller = new StellarController(stellar as unknown as StellarService);
  });

  describe('GET /stellar/ledger', () => {
    it('returns the latest ledger sequence', async () => {
      stellar.getLatestLedger.mockResolvedValue(52_000_123);
      await expect(controller.getLatestLedger()).resolves.toEqual({ sequence: 52_000_123 });
    });
  });

  describe('GET /stellar/balance/:address', () => {
    it('returns the native balance for a funded account', async () => {
      stellar.getBalance.mockResolvedValue('99.5000000');
      await expect(controller.getBalance(VALID)).resolves.toEqual({
        address: VALID,
        balance: '99.5000000',
      });
      expect(stellar.getBalance).toHaveBeenCalledWith(VALID);
    });

    it('rejects a malformed address with 400 before touching Horizon', async () => {
      await expect(controller.getBalance('not-an-address')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(controller.getBalance('GABC')).rejects.toBeInstanceOf(BadRequestException);
      expect(stellar.getBalance).not.toHaveBeenCalled();
    });

    it('maps an unfunded/nonexistent account to 404', async () => {
      stellar.getBalance.mockRejectedValue(new StellarAccountNotFoundError(VALID));
      await expect(controller.getBalance(VALID)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('propagates an unexpected error rather than masking it as 404', async () => {
      stellar.getBalance.mockRejectedValue(new Error('Horizon 503'));
      await expect(controller.getBalance(VALID)).rejects.toThrow('Horizon 503');
    });
  });
});
