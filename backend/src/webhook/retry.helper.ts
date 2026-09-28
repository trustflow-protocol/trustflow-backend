/**
 * Shared retry-with-backoff for webhook delivery. `WebhookService.sendWithRetry`
 * uses this rather than re-implementing the loop inline (#239).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  baseDelayMs: number,
  shouldRetry: (error: unknown) => boolean = () => true,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!shouldRetry(err)) break;
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, baseDelayMs * attempt));
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError ?? 'All retries exhausted'));
}

/**
 * Whether an error from a webhook delivery attempt is worth retrying.
 *
 * Retries transient network failures, real HTTP 5xx responses, and rate-limiting (429).
 * Does NOT retry permanent 4xx errors (401/403/404/etc.) which indicate misconfiguration.
 * The previous implementation used `error.message.includes('5')`, which matched
 * the digit 5 anywhere in the message — a URL, a byte count, a port number —
 * so a 4xx or an unrelated failure could be retried indefinitely (#239).
 *
 * `WebhookService.send()` and `DiscordService.sendWebhook()` reject with
 * `new Error(String(statusCode))`, so a bare 3-digit message *is* the HTTP status;
 * `"HTTP 502 ..."` is matched too. Discord timeouts use error strings like
 * "Discord webhook timed out after 5000ms" (#394).
 */
export function isRetryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');

  // Transient network errors
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up/i.test(message)) {
    return true;
  }

  // Discord-specific timeout (also caught above by ETIMEDOUT, but be explicit)
  if (/Discord webhook timed out/i.test(message)) {
    return true;
  }

  // Extract HTTP status code from message
  const status =
    message.trim().match(/^(\d{3})\b/)?.[1] ?? message.match(/\bHTTP\s*(\d{3})\b/i)?.[1];
  if (!status) return false;

  // Retry 5xx server errors and 429 rate limiting
  return /^5\d{2}$/.test(status) || status === '429';
}
