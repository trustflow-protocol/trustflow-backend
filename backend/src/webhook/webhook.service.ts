import { Injectable } from '@nestjs/common';
import * as https from 'https';
import * as http from 'http';

interface WebhookPayload {
  event: string;
  data: unknown;
  timestamp: string;
  /** Stable key consumers use to collapse retries from the transactional outbox. */
  dedupKey?: string;
}

/**
 * Timeout (ms) for outgoing webhook HTTP requests.
 * Configurable via WEBHOOK_TIMEOUT_MS env var; defaults to 10 seconds.
 * Prevents a single unresponsive endpoint from stalling dispatch() indefinitely.
 */
const WEBHOOK_TIMEOUT_MS = parseInt(process.env.WEBHOOK_TIMEOUT_MS || '10000', 10);

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

  private async sendWithRetry(
    url: string,
    payload: WebhookPayload,
    retries: number,
  ): Promise<void> {
    let lastError: unknown;
    for (let i = 0; i < retries; i++) {
      try {
        await this.send(url, payload);
        return;
      } catch (error) {
        lastError = error;
        if (i < retries - 1) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
      req.setTimeout(WEBHOOK_TIMEOUT_MS, () => {
        req.destroy(new Error(`Webhook request timed out after ${WEBHOOK_TIMEOUT_MS}ms`));
      });
      req.on('error', rej);
      req.write(body);
      req.end();
    });
  }
}
