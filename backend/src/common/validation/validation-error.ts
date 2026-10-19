import { BadRequestException, ValidationError } from '@nestjs/common';
import { ZodError } from 'zod';

/**
 * The single 400 contract for invalid input (#368), produced by both the class-validator
 * `ValidationPipe` (via {@link classValidatorExceptionFactory}) and Zod `.parse()` failures
 * (mapped in `SentryExceptionFilter`):
 *
 *   { statusCode: 400, message: 'Validation failed', errors: [{ field, message }] }
 */
export interface FieldError {
  /** Dotted path to the offending field, e.g. `address` or `milestones.0.amount`. */
  field: string;
  message: string;
}

export const VALIDATION_FAILED_MESSAGE = 'Validation failed';

export function validationException(errors: FieldError[]): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    message: VALIDATION_FAILED_MESSAGE,
    errors,
  });
}

/** Flattens nested class-validator errors into one entry per failed constraint. */
export function flattenClassValidatorErrors(
  errors: ValidationError[],
  parentPath = '',
): FieldError[] {
  const result: FieldError[] = [];
  for (const error of errors) {
    const field = parentPath ? `${parentPath}.${error.property}` : error.property;
    for (const message of Object.values(error.constraints ?? {})) {
      result.push({ field, message });
    }
    if (error.children?.length) {
      result.push(...flattenClassValidatorErrors(error.children, field));
    }
  }
  return result;
}

/** `exceptionFactory` for the global `ValidationPipe`. */
export function classValidatorExceptionFactory(errors: ValidationError[]): BadRequestException {
  return validationException(flattenClassValidatorErrors(errors));
}

export function zodErrorToFieldErrors(error: ZodError): FieldError[] {
  return error.issues.map(issue => ({
    field: issue.path.length ? issue.path.join('.') : '(root)',
    message: issue.message,
  }));
}

/**
 * `instanceof` alone misses a ZodError raised by a second copy of the zod package, so the
 * name is accepted too.
 */
export function isZodError(error: unknown): error is ZodError {
  return (
    error instanceof ZodError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'ZodError' &&
      Array.isArray((error as { issues?: unknown }).issues))
  );
}
