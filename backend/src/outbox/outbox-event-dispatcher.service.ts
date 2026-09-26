import { Injectable, Logger } from '@nestjs/common';
import { OutboxEvent } from './outbox.types';

export type OutboxEventHandler = (event: OutboxEvent) => Promise<void>;

@Injectable()
export class OutboxEventDispatcher {
  private readonly logger = new Logger(OutboxEventDispatcher.name);
  private readonly handlers = new Map<string, OutboxEventHandler[]>();

  register(pattern: string, handler: OutboxEventHandler): void {
    const list = this.handlers.get(pattern) || [];
    list.push(handler);
    this.handlers.set(pattern, list);
  }

  async dispatch(event: OutboxEvent): Promise<void> {
    const matchedHandlers: OutboxEventHandler[] = [];
    
    for (const [pattern, list] of this.handlers.entries()) {
      if (pattern === '*' || pattern === event.type) {
        matchedHandlers.push(...list);
      } else if (pattern.endsWith('*')) {
        const prefix = pattern.slice(0, -1);
        if (event.type.startsWith(prefix)) {
          matchedHandlers.push(...list);
        }
      }
    }

    // Call handlers sequentially
    for (const handler of matchedHandlers) {
      try {
        await handler(event);
      } catch (err) {
        this.logger.error(`Handler failed for event ${event.type}:`, err);
        throw err; // OutboxRelayService will retry
      }
    }
  }
}
