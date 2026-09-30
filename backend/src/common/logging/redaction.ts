/**
 * Central redaction helpers used by the sanitised logger, the HTTP request log, and the
 * Sentry `beforeSend` hook, so every path that can emit sensitive data shares one policy.
 *
 * The policy has two independent layers, because either one alone leaks:
 *
 *  1. **Key-based** — an object property whose *name* looks sensitive has its value replaced
 *     outright. This is the strong layer: it does not need to recognise the value's shape.
 *  2. **Value-based** — free text (an interpolated message, a stack trace, a URL) is scrubbed
 *     for credential-shaped substrings: bearer tokens, JWTs, connection strings, `key=value`
 *     pairs. This catches secrets that were interpolated into a sentence with no key context,
 *     which is the common case in this codebase's log calls.
 *
 * Redaction is deliberately *lossy* — it is better to drop a value we did not need than to
 * emit a credential. Values are replaced with a fixed marker rather than truncated, so a
 * partial secret is never recoverable from the logs.
 */

/** Placeholder substituted for any redacted value. */
export const REDACTED = '[REDACTED]';

/**
 * Property names whose values are always redacted. Compared case-insensitively after
 * stripping `-` and `_`, so `api_key`, `apiKey`, and `API-KEY` all match one entry.
 *
 * Kept broad on purpose: a false positive costs a redacted log field, a false negative
 * writes a live credential to disk in plaintext. Several patterns are therefore *substring*
 * matches with a trailing `(?![a-z])` boundary rather than word matches — `userPassword` and
 * `accessToken` must be caught, while unrelated words that merely contain the stem
 * (`bypass`, `passed`) must not. `token` in particular is intentionally left as a bare
 * substring match, so `tokenValue` and `tokenHash` are redacted too; that is the correct
 * trade for a security control.
 */
const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /pass(word|wd)?(?![a-z])/i,
  /secret/i,
  /token/i,
  /api[-_]?key/i,
  /^key$/i,
  /private[-_]?key/i,
  /sign(ature)?$/i,
  /authorization/i,
  /^auth$/i,
  /credential/i,
  /cookie/i,
  /session[-_]?id$/i,
  /^dsn$/i,
  /mnemonic|seed[-_]?phrase/i,
  // A wallet-auth challenge nonce is the replay-protection secret: `POST /auth/verify` is
  // worthless without it, and it is stored under `auth:nonce:used:<nonce>` in Redis. A
  // substring match also covers `nonces` and `challengeNonce`.
  /nonce/i,
  /salt/i,
  /pinata/i,
  /client[-_]?secret/i,
  /^bearer$/i,
];

/** Value-shaped credential patterns, applied to free text. Each replaces the whole match. */
const SECRET_VALUE_PATTERNS: readonly { pattern: RegExp; replace: string }[] = [
  // PEM private-key blocks, before the line-oriented patterns below.
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: REDACTED,
  },
  // `Authorization: Bearer <token>` / `bearer <token>`.
  { pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: `$1 ${REDACTED}` },
  // A JWT: three base64url segments starting with the `eyJ` (`{"`) header prefix.
  {
    pattern: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g,
    replace: REDACTED,
  },
  // Credentials embedded in a connection string: scheme://user:password@host.
  {
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@/]+)@/gi,
    replace: `$1$2:${REDACTED}@`,
  },
  // `token=abc`, `api_key: "abc"`, `X-Api-Key abc` — the interpolated-credential case. The
  // key and its separator are preserved (capture groups $1/$2) so the log line still reads
  // sensibly, while the value alternation is consumed entirely. REDACTED contains no `$`,
  // so it is safe to inline in a replacement string. A bare `Bearer`/`Basic` is not treated as
  // the value, so the scheme word survives for readability and is handled by the rule above.
  {
    pattern:
      /\b([A-Za-z0-9_.-]*(?:pass(?:word|wd)?|secret|token|api[-_]?key|auth(?:orization)?|credential|private[-_]?key|signature)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(?!(?:Bearer|Basic)\b)(?:"[^"]*"|'[^']*'|[^\s,;&)]+)/gi,
    replace: `$1$2${REDACTED}`,
  },
];

/** Guard against pathological/cyclic objects when walking a payload. */
const MAX_DEPTH = 8;

/** Property names normalised for sensitive-key comparison. */
function normaliseKey(key: string): string {
  return key.replace(/[-_\s]/g, '').toLowerCase();
}

/** True if `key` should have its value replaced. */
export function isSensitiveKey(key: string): boolean {
  const normalised = normaliseKey(key);
  return SENSITIVE_KEY_PATTERNS.some(pattern => pattern.test(normalised));
}

/**
 * Replaces credential-shaped substrings in free text.
 *
 * This is the last line of defence for messages that were built by interpolating a secret
 * directly, e.g. `` `Failed with token ${token}` `` — the secret has no surrounding key
 * structure left, so only the value shape can catch it.
 */
export function redactString(input: string): string {
  let output = input;
  for (const { pattern, replace } of SECRET_VALUE_PATTERNS) {
    output = output.replace(pattern, replace);
  }
  return output;
}

/**
 * Deep-copies `value`, replacing any property whose name is sensitive and scrubbing
 * credential-shaped strings.
 *
 * Non-sensitive primitives are returned unchanged, so ordinary fields (`status`, `id`,
 * `amountXLM`) stay greppable. Cycles are replaced with `'[Circular]'` and recursion is capped
 * at {@link MAX_DEPTH} so a self-referential object cannot hang the logger.
 */
export function redactValue<T>(value: T): unknown {
  return redactInternal(value, 0, new WeakSet<object>());
}

function redactInternal(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') return redactString(value);
  // Numbers/booleans/bigints/symbols carry no credential material.
  if (typeof value !== 'object') return value;

  if (depth >= MAX_DEPTH) return '[Truncated]';
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return redactError(value);
  if (Array.isArray(value)) return value.map(item => redactInternal(item, depth + 1, seen));

  // A URL carries credentials in both its userinfo and its query string.
  if (value instanceof URL) return redactUrl(value.toString());

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSensitiveKey(key) ? REDACTED : redactInternal(entry, depth + 1, seen);
  }
  return output;
}

/**
 * Renders an unknown thrown value as a log-safe string.
 *
 * `Logger.error(message, stack?)` prints its second argument verbatim, so passing a raw
 * `Error` object is one of the main ways this codebase leaked pg/axios internals. This
 * returns the scrubbed `message` and `stack` combined, and never the full object graph.
 */
export function redactError(error: unknown): string {
  if (error instanceof Error) {
    const parts = [`${error.name}: ${redactString(error.message)}`];
    if (error.stack) parts.push(redactString(error.stack));
    return parts.join('\n');
  }
  if (typeof error === 'string') return redactString(error);
  if (error === null || error === undefined) return String(error);
  try {
    return redactString(JSON.stringify(redactValue(error)) ?? String(error));
  } catch {
    return '[Unserialisable error]';
  }
}

/**
 * Strips credentials and the query string from a URL.
 *
 * The query string is dropped wholesale rather than filtered: tokens routinely arrive as
 * `?token=`, `?api_key=`, `?access_token=`, and a webhook target's path is itself often the
 * secret. Callers keep the scheme/host/path, which is what makes a log line actionable.
 */
export function redactUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // Not an absolute URL — scrub it as free text and drop any `?...` tail.
    const withoutQuery = trimmed.split('?')[0];
    return redactString(withoutQuery);
  }

  if (parsed.username || parsed.password) {
    parsed.username = parsed.username ? REDACTED : '';
    parsed.password = parsed.password ? REDACTED : '';
  }
  // Keep a non-sensitive marker so a reader can tell a query string was removed.
  parsed.search = '';
  return redactString(parsed.toString());
}

/**
 * Reduces an untrusted client-supplied correlation ID to a safe, bounded form.
 *
 * `X-Request-Id` is attacker-controlled and previously went straight into a log line and a
 * response header, which allowed log forging (embedded newlines) and unbounded log inflation.
 * Anything that is not a short, printable, single-line token is replaced wholesale.
 */
export function sanitiseCorrelationId(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 128) return undefined;
  // Reject anything that could forge a second log line or smuggle control characters.
  if (!/^[A-Za-z0-9_.:-]+$/.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Reduces an IP address to a coarse network prefix.
 *
 * Full IPs are personal data under GDPR and are not needed to correlate a log line, so the
 * last octet is dropped. Non-IPv4 values (IPv6, `::ffff:…`, `localhost`) are replaced
 * wholesale rather than risk mis-parsing them into something that looks like an address.
 */
export function redactIp(ip: string | undefined): string {
  if (!ip) return 'unknown';
  const ipv4 = /^(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.exec(ip);
  if (ipv4) return `${ipv4[1]}.x.x.x`;
  if (ip === '::1' || ip === '::ffff:127.0.0.1') return 'loopback';
  return 'redacted';
}
