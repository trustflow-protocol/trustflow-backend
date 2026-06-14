import { Injectable } from '@nestjs/common';
import * as https from 'https';
import * as http from 'http';

interface WebhookPayload {
  event: string;
  data: unknown;
  timestamp: string;
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

  async dispatch(event: string, data: unknown) {
    const payload: WebhookPayload = { event, data, timestamp: new Date().toISOString() };
    const promises = [...this.endpoints.values()].map(url => this.sendWithRetry(url, payload, 3));
    await Promise.allSettled(promises);
  }

  private async sendWithRetry(
    url: string,
    payload: WebhookPayload,
    retries: number,
  ): Promise<void> {
    for (let i = 0; i < retries; i++) {
      try {
        await this.send(url, payload);
        return;
      } catch {
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
      }
    }
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
