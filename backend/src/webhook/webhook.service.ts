import { Injectable } from '@nestjs/common';
import * as https from 'https';
import * as http from 'http';
import * as crypto from 'crypto';
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

@Injectable()
export class WebhookService {
  private endpoints = new Map<string, WebhookEndpointConfig>();

  register(id: string, url: string, secret?: string) {
    this.endpoints.set(id, { url, secret });
  }
  unregister(id: string) {
    this.endpoints.delete(id);
  }

  async dispatch(event: string, data: unknown, dedupKey?: string) {
    const payload: WebhookPayload = { event, data, timestamp: new Date().toISOString(), dedupKey };
    const promises = [...this.endpoints.values()].map(endpoint =>
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
