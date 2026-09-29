import {
  REDACTED,
  isSensitiveKey,
  redactError,
  redactIp,
  redactString,
  redactUrl,
  redactValue,
  sanitiseCorrelationId,
} from './redaction';

/**
 * The redaction policy is the enforcement point for "sensitive data is never logged", so these
 * tests are written adversarially: each one asserts that a *specific* known secret does not
 * appear in the output, rather than only that the output changed.
 */
describe('redaction', () => {
  describe('isSensitiveKey', () => {
    it.each([
      'password',
      'Password',
      'passwd',
      'userPassword',
      'JWT_SECRET',
      'jwtSecret',
      'secret',
      'clientSecret',
      'token',
      'accessToken',
      'refresh_token',
      'apiKey',
      'api_key',
      'API-KEY',
      'x-api-key',
      'privateKey',
      'private_key',
      'authorization',
      'Authorization',
      'auth',
      'credential',
      'cookie',
      'sessionId',
      'dsn',
      'mnemonic',
      'seedPhrase',
      'pinataJwt',
      'signature',
      'key',
    ])('treats %s as sensitive', key => {
      expect(isSensitiveKey(key)).toBe(true);
    });

    it.each([
      'id',
      'status',
      'amountXLM',
      'contractEscrowId',
      'correlationId',
      'method',
      'route',
      'monkey',
      'keyword',
      'passed',
      'compassed',
    ])('does not treat %s as sensitive', key => {
      expect(isSensitiveKey(key)).toBe(false);
    });

    it('still redacts a sensitive-looking name that merely extends the stem', () => {
      // Deliberately broader than a word match: `tokenValue` is a plausible field name and a
      // miss here is a live credential in the logs, which is a far worse outcome than a
      // redacted field named `tokenizer` or `bypass`. Both over-redactions are accepted.
      expect(isSensitiveKey('tokenValue')).toBe(true);
      expect(isSensitiveKey('tokenizer')).toBe(true);
      expect(isSensitiveKey('bypass')).toBe(true);
    });
  });

  describe('redactValue', () => {
    it('replaces the value of a sensitive key but keeps the key visible', () => {
      const result = redactValue({ password: 'hunter2', username: 'alice' }) as Record<
        string,
        unknown
      >;

      expect(result.password).toBe(REDACTED);
      expect(JSON.stringify(result)).not.toContain('hunter2');
      // Non-sensitive fields must survive, or the logs stop being useful.
      expect(result.username).toBe('alice');
    });

    it('redacts nested objects and arrays', () => {
      const result = redactValue({
        user: { profile: { apiKey: 'ak_live_123', name: 'bob' }, sessions: [{ token: 't1' }] },
      }) as { user: { profile: { apiKey: string; name: string }; sessions: { token: string }[] } };

      expect(result.user.profile.apiKey).toBe(REDACTED);
      expect(result.user.profile.name).toBe('bob');
      expect(result.user.sessions[0].token).toBe(REDACTED);
    });

    it('scrubs a secret that was interpolated into a non-sensitive field', () => {
      const result = redactValue({ note: 'retrying with api_key=sk_live_abc123' }) as Record<
        string,
        unknown
      >;

      expect(result.note).not.toContain('sk_live_abc123');
    });

    it('preserves non-sensitive primitives', () => {
      const result = redactValue({
        count: 42,
        ok: true,
        missing: null,
        absent: undefined,
        amount: '100.5',
      }) as Record<string, unknown>;

      expect(result).toEqual({
        count: 42,
        ok: true,
        missing: null,
        absent: undefined,
        amount: '100.5',
      });
    });

    it('does not throw on a self-referential object', () => {
      const cyclic: Record<string, unknown> = { name: 'root' };
      cyclic.self = cyclic;

      expect(() => redactValue(cyclic)).not.toThrow();
      expect(JSON.stringify(redactValue(cyclic))).toContain('[Circular]');
    });

    it('caps recursion depth instead of blowing the stack', () => {
      let deep: Record<string, unknown> = { value: 'leaf' };
      for (let i = 0; i < 50; i++) deep = { nested: deep };

      expect(() => redactValue(deep)).not.toThrow();
    });

    it('renders an Error value as a scrubbed string rather than an object', () => {
      const error = new Error('connect ECONNREFUSED for postgres://u:p4ssw0rd@db:5432/x');
      const result = redactValue({ err: error }) as { err: string };

      expect(typeof result.err).toBe('string');
      expect(result.err).not.toContain('p4ssw0rd');
    });

    it('redacts a URL value in both its userinfo and its query string', () => {
      const result = redactValue({
        target: new URL('https://user:pass@hooks.example.com/a?token=abc'),
      });
      expect(JSON.stringify(result)).not.toContain('pass');
      expect(JSON.stringify(result)).not.toContain('abc');
    });
  });

  describe('redactString', () => {
    it('redacts a bearer token but keeps the scheme', () => {
      const output = redactString('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def');
      expect(output).toContain('Bearer');
      expect(output).toContain(REDACTED);
      expect(output).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    });

    it('redacts a bare JWT', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abc123signature';
      const output = redactString(`login failed for token ${jwt}`);
      expect(output).not.toContain(jwt);
      expect(output).toContain(REDACTED);
    });

    it('redacts credentials embedded in a connection string', () => {
      const output = redactString('postgres://trustflow:sup3rs3cret@db.internal:5432/trustflow');
      expect(output).toContain('trustflow');
      expect(output).toContain('db.internal:5432');
      expect(output).not.toContain('sup3rs3cret');
    });

    it('redacts a PEM private key block including its body', () => {
      const pem = [
        '-----BEGIN RSA PRIVATE KEY-----',
        'MIIEowIBAAKCAQEAtESTKEYmaterial',
        'abcdefghijklmnop',
        '-----END RSA PRIVATE KEY-----',
      ].join('\n');
      const output = redactString(`signing failed with ${pem}`);
      expect(output).not.toContain('MIIEowIBAAKCAQEAtESTKEYmaterial');
      expect(output).not.toContain('abcdefghijklmnop');
    });

    it.each([
      'token=abc123def456',
      'api_key: "sk_live_9999"',
      "password='hunter2'",
      'clientSecret=zzz999',
      'x-api-key=abc',
    ])('redacts the interpolated credential in %s', input => {
      const output = redactString(`upstream said ${input}`);
      expect(output).toMatch(new RegExp(REDACTED.replace(/[[\]]/g, '\\$&')));
      expect(output).not.toMatch(/(abc123def456|sk_live_9999|hunter2|zzz999)/);
    });

    it('leaves an ordinary message untouched', () => {
      const message =
        'Escrow esc-1 released 100 XLM for GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHI';
      expect(redactString(message)).toBe(message);
    });
  });

  describe('redactUrl', () => {
    it('drops the query string entirely', () => {
      expect(redactUrl('https://api.example.com/v1/x?token=secret&api_key=other')).toBe(
        'https://api.example.com/v1/x',
      );
    });

    it('redacts userinfo but keeps the host', () => {
      const output = redactUrl('https://admin:hunter2@internal.example.com/path');
      expect(output).toContain('internal.example.com');
      expect(output).not.toContain('hunter2');
    });

    it('handles a non-absolute URL by stripping the query', () => {
      expect(redactUrl('/v1/escrows?token=abc')).toBe('/v1/escrows');
    });

    it('returns an empty string unchanged', () => {
      expect(redactUrl('   ')).toBe('');
    });
  });

  describe('redactError', () => {
    it('renders an Error as name, message and scrubbed stack', () => {
      const error = new Error('failed with secret=s3cr3tvalue');
      const output = redactError(error);

      expect(output).toContain('Error: failed with');
      expect(output).toContain(REDACTED);
      expect(output).not.toContain('s3cr3tvalue');
    });

    it('scrubs a secret embedded in the stack trace', () => {
      const error = new Error('boom');
      error.stack = 'Error: boom\n    at run (postgres://u:topsecret@h/db)';
      const output = redactError(error);
      expect(output).not.toContain('topsecret');
    });

    it('handles a non-Error rejection reason', () => {
      expect(redactError('plain token=abc123')).toContain(REDACTED);
      expect(redactError(undefined)).toBe('undefined');
      expect(redactError(null)).toBe('null');
      expect(redactError({ password: 'x' })).not.toContain('"x"');
    });
  });

  describe('sanitiseCorrelationId', () => {
    it('accepts a short, printable, single-line token', () => {
      expect(sanitiseCorrelationId('req-123_abc.9')).toBe('req-123_abc.9');
    });

    it('rejects a value that could forge a second log line', () => {
      const forged = 'abc\n{"event":"request_start","spoofed":true}';
      expect(sanitiseCorrelationId(forged)).toBeUndefined();
    });

    it('rejects a value with a carriage return or terminal escape', () => {
      expect(sanitiseCorrelationId('abc\rdef')).toBeUndefined();
      expect(sanitiseCorrelationId('abc[31mred')).toBeUndefined();
    });

    it('rejects an over-long value that could inflate the logs', () => {
      expect(sanitiseCorrelationId('a'.repeat(129))).toBeUndefined();
    });

    it('rejects blank, missing and non-string values', () => {
      expect(sanitiseCorrelationId('   ')).toBeUndefined();
      expect(sanitiseCorrelationId(undefined)).toBeUndefined();
    });
  });

  describe('redactIp', () => {
    it('keeps only the first octet of an IPv4 address', () => {
      expect(redactIp('203.0.113.45')).toBe('203.x.x.x');
    });

    it('labels loopback explicitly', () => {
      expect(redactIp('::1')).toBe('loopback');
      expect(redactIp('::ffff:127.0.0.1')).toBe('loopback');
    });

    it('does not attempt to parse an IPv6 address into something address-like', () => {
      expect(redactIp('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe('redacted');
    });

    it('handles a missing address', () => {
      expect(redactIp(undefined)).toBe('unknown');
    });
  });
});
