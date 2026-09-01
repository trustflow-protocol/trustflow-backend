import * as http from 'http';
import * as net from 'net';
import * as crypto from 'crypto';
import { AddressInfo } from 'net';
import { Test, TestingModule } from '@nestjs/testing';
import { WebhookService, computeWebhookSignature } from './webhook.service';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Spins up a real local HTTP server for a single test. Returns its base URL
 * and a `close()` helper. The `handler` receives each incoming request so
 * tests can control the response status code.
 */
async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>(res => server.listen(0, '127.0.0.1', res));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((res, rej) => server.close(e => (e ? rej(e) : res()))),
  };
}

/** Starts a server that always responds with the given status code. */
async function serverWithStatus(status: number) {
  return startServer((_req, res) => res.writeHead(status).end());
}

/** Starts a server that accepts connections but never writes back (simulates a hung endpoint). */
async function silentServer() {
  return startServer((_req, _res) => {
    /* intentionally no response */
  });
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('WebhookService', () => {
  let service: WebhookService;

  beforeEach(async () => {
    // Disable retries during most tests by setting WEBHOOK_TIMEOUT_MS very low
    // so tests don't wait for real network timeouts.
    process.env.WEBHOOK_TIMEOUT_MS = '500';

    const module: TestingModule = await Test.createTestingModule({
      providers: [WebhookService],
    }).compile();

    service = module.get<WebhookService>(WebhookService);
  });

  afterEach(() => {
    delete process.env.WEBHOOK_TIMEOUT_MS;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ─── computeWebhookSignature() ──────────────────────────────────────────

  describe('computeWebhookSignature()', () => {
    it('computes HMAC-SHA256 hex signature matching a known test vector', () => {
      const secret = 'test-secret-key-123456';
      const payload =
        '{"event":"escrow.created","data":{"id":"esc-1"},"timestamp":"2026-08-31T00:00:00.000Z"}';
      const expected = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');

      const signature = computeWebhookSignature(payload, secret);

      expect(signature).toBe(expected);
      expect(signature).toHaveLength(64); // 32-byte SHA-256 = 64 hex chars
      expect(signature).toMatch(/^[0-9a-f]{64}$/);
    });

    it('produces different signatures for different secrets or payloads', () => {
      const payload = '{"event":"test"}';
      const sig1 = computeWebhookSignature(payload, 'secret-1-12345678');
      const sig2 = computeWebhookSignature(payload, 'secret-2-12345678');
      const sig3 = computeWebhookSignature('{"event":"other"}', 'secret-1-12345678');

      expect(sig1).not.toBe(sig2);
      expect(sig1).not.toBe(sig3);
    });
  });

  // ─── register / unregister ────────────────────────────────────────────────

  describe('register() / unregister()', () => {
    it('registers an endpoint so it receives dispatch() calls', async () => {
      const requests: string[] = [];
      const { url, close } = await startServer((req, res) => {
        let body = '';
        req.on('data', chunk => (body += chunk));
        req.on('end', () => {
          requests.push(body);
          res.writeHead(200).end();
        });
      });

      service.register('hook-1', url);
      await service.dispatch('test.event', { foo: 'bar' });

      expect(requests).toHaveLength(1);
      expect(JSON.parse(requests[0])).toMatchObject({ event: 'test.event', data: { foo: 'bar' } });

      await close();
    });

    it('unregistered endpoint does not receive dispatch() calls', async () => {
      const requests: string[] = [];
      const { url, close } = await startServer((_req, res) => {
        requests.push('called');
        res.writeHead(200).end();
      });

      service.register('hook-a', url);
      service.unregister('hook-a');

      await service.dispatch('test.event', {});

      expect(requests).toHaveLength(0);
      await close();
    });

    it('unregister on an unknown id does not throw', () => {
      expect(() => service.unregister('does-not-exist')).not.toThrow();
    });

    it('registers multiple endpoints under distinct ids', async () => {
      const hits: string[] = [];
      const makeServer = async (tag: string) =>
        startServer((_req, res) => {
          hits.push(tag);
          res.writeHead(200).end();
        });

      const s1 = await makeServer('A');
      const s2 = await makeServer('B');

      service.register('id-a', s1.url);
      service.register('id-b', s2.url);

      await service.dispatch('multi.event', {});

      expect(hits.sort()).toEqual(['A', 'B']);

      await s1.close();
      await s2.close();
    });
  });

  // ─── dispatch() ───────────────────────────────────────────────────────────

  describe('dispatch()', () => {
    it('sends a POST request with the correct event, data, and a timestamp', async () => {
      let received: any;
      const { url, close } = await startServer((req, res) => {
        let body = '';
        req.on('data', c => (body += c));
        req.on('end', () => {
          received = JSON.parse(body);
          res.writeHead(200).end();
        });
      });

      service.register('hook', url);
      await service.dispatch('escrow.created', { id: 'esc-1' });

      expect(received.event).toBe('escrow.created');
      expect(received.data).toEqual({ id: 'esc-1' });
      expect(typeof received.timestamp).toBe('string');
      expect(new Date(received.timestamp).toISOString()).toBe(received.timestamp);

      await close();
    });

    it('includes dedupKey in the payload when provided', async () => {
      let received: any;
      const { url, close } = await startServer((req, res) => {
        let body = '';
        req.on('data', c => (body += c));
        req.on('end', () => {
          received = JSON.parse(body);
          res.writeHead(200).end();
        });
      });

      service.register('hook', url);
      await service.dispatch('escrow.released', {}, 'dedup-key-xyz');

      expect(received.dedupKey).toBe('dedup-key-xyz');

      await close();
    });

    it('sends X-TrustFlow-Signature header matching raw body when secret is configured', async () => {
      let receivedHeaders: http.IncomingHttpHeaders | undefined;
      let receivedBody = '';
      const secret = 'super-secret-hmac-key-1234';

      const { url, close } = await startServer((req, res) => {
        receivedHeaders = req.headers;
        req.on('data', c => (receivedBody += c));
        req.on('end', () => res.writeHead(200).end());
      });

      service.register('signed-hook', url, secret);
      await service.dispatch('dispute.raised', { disputeId: 'disp-1' });

      expect(receivedHeaders).toBeDefined();
      const signatureHeader = receivedHeaders!['x-trustflow-signature'];
      expect(signatureHeader).toBeDefined();
      expect(signatureHeader).toBe(computeWebhookSignature(receivedBody, secret));

      await close();
    });

    it('omits X-TrustFlow-Signature header when secret is not configured', async () => {
      let receivedHeaders: http.IncomingHttpHeaders | undefined;

      const { url, close } = await startServer((req, res) => {
        receivedHeaders = req.headers;
        req.on('data', () => {});
        req.on('end', () => res.writeHead(200).end());
      });

      service.register('unsigned-hook', url); // no secret
      await service.dispatch('dispute.resolved', { disputeId: 'disp-1' });

      expect(receivedHeaders).toBeDefined();
      expect(receivedHeaders!['x-trustflow-signature']).toBeUndefined();

      await close();
    });

    it('handles mixed endpoints in a single dispatch: signed and unsigned receive correct headers', async () => {
      let signedHeaders: http.IncomingHttpHeaders | undefined;
      let signedBody = '';
      let unsignedHeaders: http.IncomingHttpHeaders | undefined;
      const secret = 'endpoint-a-secret-key-1234';

      const serverA = await startServer((req, res) => {
        signedHeaders = req.headers;
        req.on('data', c => (signedBody += c));
        req.on('end', () => res.writeHead(200).end());
      });

      const serverB = await startServer((req, res) => {
        unsignedHeaders = req.headers;
        req.on('data', () => {});
        req.on('end', () => res.writeHead(200).end());
      });

      service.register('signed-ep', serverA.url, secret);
      service.register('unsigned-ep', serverB.url);

      await service.dispatch('escrow.created', { id: 'esc-mix' });

      expect(signedHeaders!['x-trustflow-signature']).toBe(
        computeWebhookSignature(signedBody, secret),
      );
      expect(unsignedHeaders!['x-trustflow-signature']).toBeUndefined();

      await serverA.close();
      await serverB.close();
    });

    it('resolves without error when no endpoints are registered', async () => {
      await expect(service.dispatch('any.event', {})).resolves.not.toThrow();
    });

    it('one failing endpoint does not prevent delivery to other endpoints', async () => {
      // Use a raw TCP server that refuses connections for the failing endpoint.
      const badServer = net.createServer();
      await new Promise<void>(r => badServer.listen(0, '127.0.0.1', r));
      const { port: badPort } = badServer.address() as AddressInfo;
      badServer.close(); // close immediately so connections are refused

      const goodHits: string[] = [];
      const goodServer = await startServer((_req, res) => {
        goodHits.push('delivered');
        res.writeHead(200).end();
      });

      service.register('bad', `http://127.0.0.1:${badPort}`);
      service.register('good', goodServer.url);

      // dispatch() throws the first rejection but still fans out to all.
      await expect(service.dispatch('fan.out', {})).rejects.toThrow();
      expect(goodHits).toHaveLength(1);

      await goodServer.close();
    });

    it('throws the rejection reason when every endpoint fails', async () => {
      // Both endpoints are on closed ports.
      service.register('bad-1', 'http://127.0.0.1:19991');
      service.register('bad-2', 'http://127.0.0.1:19992');

      await expect(service.dispatch('fail.event', {})).rejects.toThrow();
    });

    it('sends to an https endpoint using the https module path', async () => {
      // We cannot easily spin up TLS in a unit test, so we verify by checking
      // that the service does not throw simply because the URL starts with
      // https:// — we mock send() to avoid actual network I/O.
      const sendSpy = jest.spyOn(service as any, 'send').mockResolvedValue(undefined);

      service.register('tls-hook', 'https://example.com/webhook', 'tls-secret-12345678');
      await service.dispatch('tls.event', {});

      expect(sendSpy).toHaveBeenCalledWith(
        'https://example.com/webhook',
        expect.objectContaining({ event: 'tls.event' }),
        'tls-secret-12345678',
      );

      sendSpy.mockRestore();
    });
  });

  // ─── sendWithRetry() / retry behaviour ────────────────────────────────────

  describe('retry behaviour', () => {
    it('retries on a 5xx response and succeeds on the next attempt', async () => {
      let callCount = 0;
      const { url, close } = await startServer((_req, res) => {
        callCount++;
        res.writeHead(callCount === 1 ? 503 : 200).end();
      });

      service.register('hook', url);
      // No error should surface — the retry recovers on attempt 2.
      await expect(service.dispatch('retry.event', {})).resolves.not.toThrow();
      expect(callCount).toBe(2);

      await close();
    });

    it('does not retry on a 4xx response', async () => {
      let callCount = 0;
      const { url, close } = await startServer((_req, res) => {
        callCount++;
        res.writeHead(404).end();
      });

      service.register('hook', url);
      await expect(service.dispatch('no.retry', {})).rejects.toThrow();
      // Should have been called exactly once — no retries for 4xx.
      expect(callCount).toBe(1);

      await close();
    });

    it('exhausts all retries (3) when the endpoint consistently returns 503', async () => {
      let callCount = 0;
      const { url, close } = await startServer((_req, res) => {
        callCount++;
        res.writeHead(503).end();
      });

      service.register('hook', url);
      await expect(service.dispatch('always.fail', {})).rejects.toThrow();
      expect(callCount).toBe(3); // 1 original + 2 retries = 3 total

      await close();
    });
  });

  // ─── send() — status code handling ───────────────────────────────────────

  describe('send() — HTTP status handling', () => {
    it.each([200, 201, 204, 302])('resolves for HTTP %d (< 400)', async status => {
      const { url, close } = await serverWithStatus(status);
      service.register('hook', url);
      await expect(service.dispatch('ok.event', {})).resolves.not.toThrow();
      await close();
    });

    it.each([400, 401, 403, 422])('rejects (no retry) for HTTP %d (4xx)', async status => {
      let calls = 0;
      const { url, close } = await startServer((_req, res) => {
        calls++;
        res.writeHead(status).end();
      });
      service.register('hook', url);
      await expect(service.dispatch('err.event', {})).rejects.toThrow(String(status));
      expect(calls).toBe(1);
      await close();
    });
  });
});
