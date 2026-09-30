import {
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  registerDecorator,
} from 'class-validator';
import { STELLAR_ADDRESS_REGEX } from '../../escrow/escrow.dto';

@ValidatorConstraint({ name: 'isStellarPublicKey', async: false })
export class IsStellarPublicKeyConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, _args: ValidationArguments): boolean {
    return typeof value === 'string' && STELLAR_ADDRESS_REGEX.test(value);
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be a valid Stellar public key`;
  }
}

export function IsStellarPublicKey(validationOptions?: ValidationOptions) {
  return function (object: Record<string, any>, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsStellarPublicKeyConstraint,
    });
  };
}
