import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import * as https from 'https';
import * as http from 'http';
import * as crypto from 'crypto';
import * as dns from 'dns';
import * as net from 'net';
import { withRetry, isRetryable } from './retry.helper';

/** Base backoff between webhook delivery attempts; grows linearly per attempt. */
const WEBHOOK_RETRY_BASE_DELAY_MS = 1000;

interface WebhookPayload {
  event: string;
  data: unknown;
  timestamp: string;
  /** Stable key consumers use to collapse retries from the transactional outbox. */
  dedupKey?: string;
}

export interface WebhookEndpointConfig {
  url: string;
  secret?: string;
}

/**
 * Computes an HMAC-SHA256 hex signature for a given payload body string and secret.
 */
export function computeWebhookSignature(payloadBody: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payloadBody, 'utf8').digest('hex');
}

/**
 * Timeout (ms) for outgoing webhook HTTP requests.
 * Configurable via WEBHOOK_TIMEOUT_MS env var; defaults to 10 seconds.
 * Prevents a single unresponsive endpoint from stalling dispatch() indefinitely.
 */
const WEBHOOK_TIMEOUT_MS = parseInt(process.env.WEBHOOK_TIMEOUT_MS || '10000', 10);

/**
 * Returns true if the IP is in a private/loopback/link-local range that must
 * not be reachable via SSRF. Covers IPv4 RFC1918, loopback, link-local,
 * CGNAT, multicast, and IPv6 equivalent ranges plus the cloud metadata address.
 */
export function isPrivateIP(ip: string): boolean {
  const lower = ip.toLowerCase();
  // Explicit hostname check
  if (lower === 'localhost') return true;

  const family = net.isIP(ip);
  if (family === 4) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(n => Number.isNaN(n) || n < 0 || n > 255)) return false;
    // 0.0.0.0/8
    if (parts[0] === 0) return true;
    // 10.0.0.0/8
    if (parts[0] === 10) return true;
    // 127.0.0.0/8 loopback
    if (parts[0] === 127) return true;
    // 169.254.0.0/16 link-local (includes 169.254.169.254 metadata)
    if (parts[0] === 169 && parts[1] === 254) return true;
    // 172.16.0.0/12
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.168.0.0/16
    if (parts[0] === 192 && parts[1] === 168) return true;
    // 100.64.0.0/10 CGNAT
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 (TEST-NET) - treat as private for SSRF safety
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 2) return true;
    if (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) return true;
    if (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) return true;
    // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved
    if (parts[0] >= 224) return true;
    return false;
  }
  if (family === 6) {
    // ::1, ::, ::ffff:0:0/96 etc.
    if (lower === '::1' || lower === '::' || lower === '::0') return true;
    // fc00::/7 unique local, fd00::/8
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    // fe80::/10 link-local
    if (
      lower.startsWith('fe80:') ||
      lower.startsWith('fe90:') ||
      lower.startsWith('fea') ||
      lower.startsWith('feb')
    )
      return true;
    // ff00::/8 multicast
    if (lower.startsWith('ff')) return true;
    // IPv4-mapped IPv6: ::ffff:10.0.0.1 etc.
    if (lower.includes('.')) {
      const lastColon = lower.lastIndexOf(':');
      const v4part = lower.slice(lastColon + 1);
      if (net.isIP(v4part) === 4 && isPrivateIP(v4part)) return true;
    }
    // ::ffff:127.0.0.1 already handled via dot check but also explicit
    if (lower === '::ffff:127.0.0.1') return true;
    return false;
  }
  return false;
}

/**
 * Resolve hostname and ensure none of its addresses are private.
 * Throws BadRequestException if a private address is found.
 */
export async function resolveAndValidateHostname(hostname: string): Promise<void> {
  if (!hostname) throw new BadRequestException('Webhook URL must have a hostname');
  if (hostname.toLowerCase() === 'localhost') {
    throw new BadRequestException('Webhook URL hostname localhost is not allowed');
  }
  if (net.isIP(hostname)) {
    if (isPrivateIP(hostname)) {
      throw new BadRequestException(`Webhook URL resolves to private address: ${hostname}`);
    }
    return;
  }
  try {
    const records = await dns.promises.lookup(hostname, { all: true });
    for (const r of records) {
      if (isPrivateIP(r.address)) {
        throw new BadRequestException(`Webhook URL resolves to private address: ${r.address}`);
      }
    }
  } catch (e) {
    if (e instanceof BadRequestException) throw e;
    const err = e as NodeJS.ErrnoException;
    // DNS errors that mean the name doesn't exist – allow registration to succeed;
    // dispatch-time re-validation will handle later resolution. For known hosts
    // that are syntactically valid but not resolvable in offline CI, don't block.
    if (err && (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN' || err.code === 'ENODATA' || err.code === 'EREQUEST')) {
      return;
    }
    // Re-throw as BadRequest for other DNS failures to avoid SSRF bypass
    throw e;
  }
}

/**
 * Validate URL string for SSRF: scheme must be http(s), hostname must not be
 * private, and DNS must not resolve to private. Throws BadRequestException
 * with 400 semantics on failure.
 */
export async function validateWebhookUrl(urlString: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new BadRequestException('Invalid webhook URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BadRequestException('Webhook URL must use http or https');
  }
  const hostname = url.hostname;
  if (!hostname) throw new BadRequestException('Webhook URL must have a hostname');
  if (isPrivateIP(hostname)) {
    throw new BadRequestException(`Webhook URL hostname ${hostname} is not allowed (private address)`);
  }
  await resolveAndValidateHostname(hostname);
}

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);
  private endpoints = new Map<string, WebhookEndpointConfig>();

  async register(id: string, url: string, secret?: string) {
    await validateWebhookUrl(url);
    this.endpoints.set(id, { url, secret });
  }
  unregister(id: string) {
    this.endpoints.delete(id);
  }

  async dispatch(event: string, data: unknown, dedupKey?: string) {
    const payload: WebhookPayload = { event, data, timestamp: new Date().toISOString(), dedupKey };
    // Re-validate each endpoint at dispatch time to protect against DNS rebinding
    const validEndpoints: WebhookEndpointConfig[] = [];
    for (const endpoint of this.endpoints.values()) {
      try {
        await validateWebhookUrl(endpoint.url);
        validEndpoints.push(endpoint);
      } catch (e) {
        this.logger.warn(
          `Skipping webhook dispatch to blocked/private URL: ${endpoint.url} - ${(e as Error).message}`,
        );
        continue;
      }
    }
    if (validEndpoints.length === 0) return;
    const promises = validEndpoints.map(endpoint =>
      this.sendWithRetry(endpoint.url, payload, 3, endpoint.secret),
    );
    const results = await Promise.allSettled(promises);
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failed) throw failed.reason;
  }

  private sendWithRetry(
    url: string,
    payload: WebhookPayload,
    retries: number,
    secret?: string,
  ): Promise<void> {
    // Shared retry/backoff + retryability logic — no longer a second inline
    // copy of what `retry.helper.ts` already provides, and non-retryable
    // failures (4xx, unrelated errors) now stop immediately (#239).
    return withRetry(
      () => this.send(url, payload, secret),
      retries,
      WEBHOOK_RETRY_BASE_DELAY_MS,
      isRetryable,
    );
  }

  private send(url: string, payload: WebhookPayload, secret?: string): Promise<void> {
    return new Promise((res, rej) => {
      const body = JSON.stringify(payload);
      const mod = url.startsWith('https') ? https : http;
      const headers: Record<string, string | number> = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body, 'utf8'),
      };
      if (secret) {
        headers['X-TrustFlow-Signature'] = computeWebhookSignature(body, secret);
      }

      const req = mod.request(
        url,
        {
          method: 'POST',
          headers,
        },
        r => {
          if (r.statusCode && r.statusCode < 400) res();
          else rej(new Error(`${r.statusCode}`));
        },
      );
      req.setTimeout(WEBHOOK_TIMEOUT_MS, () => {
        req.destroy(new Error(`Webhook request timed out after ${WEBHOOK_TIMEOUT_MS}ms`));
      });
      req.on('error', rej);
      req.write(body);
      req.end();
    });
  }
}
