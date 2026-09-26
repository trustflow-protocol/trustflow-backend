/**
 * Timezone policy: All dates in the system are stored and transmitted in UTC (ISO 8601).
 * This ensures consistency across services, timezones, and restarts.
 *
 * Guidelines:
 * - Use `getCurrentUtcDate()` to get the current time in UTC.
 * - Use `toUtcIsoString()` to format dates for storage and API responses.
 * - Use `parseUtcDate()` to parse ISO 8601 strings from external sources.
 * - Never rely on local system timezone for date operations.
 */

/**
 * Returns the current time as a UTC Date object.
 * Equivalent to `new Date()` but with explicit intent that the result is UTC.
 */
export function getCurrentUtcDate(): Date {
  return new Date();
}

/**
 * Converts a Date to a UTC ISO 8601 string (e.g., "2026-09-26T12:00:00Z").
 * Used for all date fields in API responses and persistence layers.
 */
export function toUtcIsoString(date: Date): string {
  if (!(date instanceof Date) || isNaN(date.getTime())) {
    throw new Error('Invalid date provided to toUtcIsoString');
  }
  return date.toISOString();
}

/**
 * Parses a UTC ISO 8601 string into a Date object.
 * Used when receiving dates from external sources (API bodies, databases).
 *
 * @throws Error if the input is not a valid ISO 8601 string
 */
export function parseUtcDate(isoString: string): Date {
  if (typeof isoString !== 'string') {
    throw new Error('Expected ISO 8601 string, got ' + typeof isoString);
  }
  const date = new Date(isoString);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid ISO 8601 date string: "${isoString}"`);
  }
  return date;
}

/**
 * Asserts that a date is represented in UTC ISO 8601 format.
 * Used in validation pipes and serializers to reject non-UTC dates.
 *
 * @throws Error if the string is not in UTC (does not end with "Z")
 */
export function assertUtcIsoString(isoString: string): asserts isoString is string {
  if (!isoString.endsWith('Z')) {
    throw new Error(
      `Date must be in UTC ISO 8601 format (ending with 'Z'), got: "${isoString}"`,
    );
  }
  try {
    parseUtcDate(isoString);
  } catch (error) {
    throw new Error(`Invalid date string: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Calculates the time until a deadline in milliseconds.
 * Returns 0 or negative if the deadline has passed.
 *
 * @param deadline A Date object or ISO 8601 string in UTC
 */
export function getTimeUntilDeadline(deadline: Date | string): number {
  const deadlineDate = typeof deadline === 'string' ? parseUtcDate(deadline) : deadline;
  return deadlineDate.getTime() - getCurrentUtcDate().getTime();
}

/**
 * Checks if a deadline has passed.
 *
 * @param deadline A Date object or ISO 8601 string in UTC
 */
export function isDeadlinePassed(deadline: Date | string): boolean {
  return getTimeUntilDeadline(deadline) <= 0;
}
