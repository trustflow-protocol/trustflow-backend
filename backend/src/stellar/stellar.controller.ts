import { BadRequestException, Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { StrKey } from '@stellar/stellar-sdk';
import { StellarAccountNotFoundError, StellarService } from './stellar.service';

/**
 * Read-only Stellar/Horizon lookups (#221). `StellarService` was fully wired
 * into `AppModule` via `StellarModule` but never reachable — nothing injected
 * it and no route exposed it. These endpoints make it usable and add the
 * address validation / not-found handling the raw service left to callers.
 */
@ApiTags('Stellar')
@Controller('stellar')
export class StellarController {
  constructor(private readonly stellar: StellarService) {}

  @Get('ledger')
  @ApiOperation({ summary: 'Latest closed ledger sequence' })
  @ApiResponse({ status: 200, schema: { example: { sequence: 52000000 } } })
  async getLatestLedger(): Promise<{ sequence: number }> {
    return { sequence: await this.stellar.getLatestLedger() };
  }

  @Get('balance/:address')
  @ApiOperation({ summary: 'Native XLM balance for a Stellar account' })
  @ApiParam({
    name: 'address',
    example: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
    description: 'Stellar account public key (G… strkey)',
  })
  @ApiResponse({ status: 200, schema: { example: { address: 'GA7Q…', balance: '99.5000000' } } })
  @ApiResponse({ status: 400, description: 'Malformed Stellar address' })
  @ApiResponse({ status: 404, description: 'Account not found on the network (unfunded or nonexistent)' })
  async getBalance(
    @Param('address') address: string,
  ): Promise<{ address: string; balance: string }> {
    if (!StrKey.isValidEd25519PublicKey(address)) {
      throw new BadRequestException(
        'Not a valid Stellar account public key (expected a G… strkey)',
      );
    }

    try {
      return { address, balance: await this.stellar.getBalance(address) };
    } catch (err) {
      if (err instanceof StellarAccountNotFoundError) {
        throw new NotFoundException(err.message);
      }
      throw err;
    }
  }
}
