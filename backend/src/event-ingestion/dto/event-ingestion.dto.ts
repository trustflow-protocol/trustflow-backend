import {
  IsString,
  IsOptional,
  IsInt,
  Min,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { Transform, TransformFnParams } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StrKey } from '@stellar/stellar-sdk';
import { normalizeContractId } from '../../stellar/contract-id.util';

/**
 * Normalizes a contract ID to its canonical StrKey casing before validation runs, so a value
 * typed in a different case than how it's stored elsewhere still passes `IsValidStellarContract`
 * and compares equal everywhere downstream (#979).
 */
const NormalizeContractId = () =>
  Transform(({ value }: TransformFnParams): unknown =>
    typeof value === 'string' ? normalizeContractId(value) : value,
  );

@ValidatorConstraint({ name: 'isValidStellarContract', async: false })
export class IsValidStellarContractConstraint implements ValidatorConstraintInterface {
  validate(value: string): boolean {
    try {
      return StrKey.isValidContract(value);
    } catch {
      return false;
    }
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be a valid Stellar contract ID (C...)`;
  }
}

export function IsValidStellarContract(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsValidStellarContractConstraint,
    });
  };
}

export class StartPollingDto {
  @ApiPropertyOptional({ description: 'Contract ID to monitor' })
  @IsString()
  @NormalizeContractId()
  @IsValidStellarContract()
  @IsOptional()
  contractId?: string;
}

export class IngestLedgerDto {
  @ApiProperty({ description: 'Contract ID to ingest events for' })
  @IsString()
  @NormalizeContractId()
  @IsValidStellarContract()
  contractId!: string;

  @ApiProperty({ description: 'Ledger sequence to ingest (must be positive integer)' })
  @IsInt()
  @Min(1)
  ledger!: number;
}

export class HandleReorgDto {
  @ApiProperty({ description: 'Contract ID affected by reorg' })
  @IsString()
  @NormalizeContractId()
  @IsValidStellarContract()
  contractId!: string;

  @ApiProperty({ description: 'Ledger sequence to reprocess from (must be positive integer)' })
  @IsInt()
  @Min(1)
  fromLedger!: number;
}
