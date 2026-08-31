import { Injectable } from '@nestjs/common';
import * as https from 'https';
import * as http from 'http';
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

@Injectable()
export class WebhookService {
  private endpoints = new Map<string, string>();

  register(id: string, url: string) {
    this.endpoints.set(id, url);
  }
  unregister(id: string) {
    this.endpoints.delete(id);
  }

  async dispatch(event: string, data: unknown, dedupKey?: string) {
    const payload: WebhookPayload = { event, data, timestamp: new Date().toISOString(), dedupKey };
    const promises = [...this.endpoints.values()].map(url => this.sendWithRetry(url, payload, 3));
    const results = await Promise.allSettled(promises);
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failed) throw failed.reason;
  }

  private sendWithRetry(url: string, payload: WebhookPayload, retries: number): Promise<void> {
    // Shared retry/backoff + retryability logic — no longer a second inline
    // copy of what `retry.helper.ts` already provides, and non-retryable
    // failures (4xx, unrelated errors) now stop immediately (#239).
    return withRetry(
      () => this.send(url, payload),
      retries,
      WEBHOOK_RETRY_BASE_DELAY_MS,
      isRetryable,
    );
  }

  private send(url: string, payload: WebhookPayload): Promise<void> {
    return new Promise((res, rej) => {
      const body = JSON.stringify(payload);
      const mod = url.startsWith('https') ? https : http;
      const req = mod.request(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
        },
        r => {
          if (r.statusCode && r.statusCode < 400) res();
          else rej(new Error(`${r.statusCode}`));
        },
      );
      req.on('error', rej);
      req.write(body);
      req.end();
    });
  }
}
