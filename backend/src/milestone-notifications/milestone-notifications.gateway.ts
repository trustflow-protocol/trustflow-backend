import { OnModuleInit, OnModuleDestroy, Inject, Optional } from '@nestjs/common';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import {
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { OUTBOX_GATEWAY_CHANNEL } from '../outbox/outbox-publisher.service';
import { OutboxEvent } from '../outbox/outbox.types';
import { EventDedupService } from './event-dedup.service';

export interface ClientEventPayload {
  v: number;
  type: string;
  data: unknown;
}

@WebSocketGateway({ cors: { origin: '*' } })
export class MilestoneNotificationsGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new SanitizedLogger(MilestoneNotificationsGateway.name);
  private subscriber: Redis | null = null;
  /** Live client sockets, so a drain can notify and close them rather than just vanishing. */
  private readonly clients = new Map<string, Socket>();
  private draining = false;
  /**
   * Serialises outbox message handling.
   *
   * Claiming an event is now an async Redis round-trip, so two messages arriving in quick
   * succession would otherwise be able to resolve out of order and deliver `gig.accepted`
   * after `gig.completed`. Chaining every message onto this promise preserves the per-escrow
   * ordering guarantee the previous synchronous handler gave for free.
   */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    @Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
    private readonly dedup: EventDedupService,
  ) {}

  @WebSocketServer()
  server!: Server;

  onModuleInit() {
    if (this.redis) {
      this.subscriber = this.redis.duplicate();

      this.subscriber.on('error', err =>
        this.logger.error(`Subscriber Redis error: ${err.message}`),
      );
      this.subscriber.on('connect', () => this.logger.log('Subscriber connected to Redis'));

      void this.subscriber.subscribe(OUTBOX_GATEWAY_CHANNEL, err => {
        if (err) {
          this.logger.error(`Failed to subscribe to ${OUTBOX_GATEWAY_CHANNEL}`, err.stack);
        } else {
          this.logger.log(`Subscribed to ${OUTBOX_GATEWAY_CHANNEL}`);
        }
      });

      this.subscriber.on('message', (channel, message) => {
        if (channel === OUTBOX_GATEWAY_CHANNEL) {
          this.handleOutboxMessage(message);
        }
      });
    } else {
      this.logger.warn(
        'No Redis client provided; running in local mode without outbox subscription',
      );
    }
  }

  /**
   * Closes every live socket, telling each client why first.
   *
   * Previously `onModuleDestroy` only tore down the Redis subscriber, so on shutdown each
   * connected client saw its socket die with no indication of why and no opportunity to
   * reconnect elsewhere. A `server:shutdown` event followed by `disconnect` lets a client
   * fail over to a healthy replica immediately instead of waiting for a TCP timeout.
   */
  async drainClients(reason = 'server shutting down'): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    const count = this.clients.size;
    if (count === 0) return;

    this.logger.log(`Draining ${count} WebSocket client(s): ${reason}`);

    for (const client of this.clients.values()) {
      try {
        client.emit('server:shutdown', { reason, reconnect: true });
      } catch {
        // A socket that is already gone needs no notification.
      }
    }

    // Give the emit a turn of the event loop to reach the wire before the socket closes.
    await new Promise<void>(resolve => setImmediate(resolve));

    if (this.server) {
      void this.server.close();
    }
    for (const client of this.clients.values()) {
      try {
        void client.disconnect(true);
      } catch {
        // Best effort — the server close above has already stopped new work.
      }
    }
    this.clients.clear();

    this.logger.log(`WebSocket drain complete`);
  }

  async onModuleDestroy() {
    if (this.subscriber) {
      void this.subscriber
        .unsubscribe(OUTBOX_GATEWAY_CHANNEL)
        .catch(err => this.logger.error(`Failed to unsubscribe`, err));
      this.subscriber.disconnect();
      this.subscriber = null;
    }
    await this.drainClients('application shutting down');
  }

  /**
   * Enqueues an outbox message for processing.
   *
   * Stays synchronous so the Redis `'message'` listener and its tests keep the same shape;
   * the actual work is chained onto {@link queue} to preserve event ordering now that the
   * dedup claim is asynchronous.
   */
  private handleOutboxMessage(message: string): void {
    this.queue = this.queue
      .then(() => this.processOutboxMessage(message))
      .catch(err => this.logger.error('Failed to process outbox message', err));
  }

  /**
   * #646 — claim the event before broadcasting it.
   *
   * `dedupKey` is the outbox's own idempotency contract ("stable across retries"), so it is
   * the right thing to key on; `id` is only a fallback for a malformed event. The claim is
   * resolved across replicas, so exactly one of them broadcasts and scaling out no longer
   * multiplies message volume for connected clients.
   */
  private async processOutboxMessage(message: string): Promise<void> {
    const event = JSON.parse(message) as OutboxEvent;
    const eventKey = event.dedupKey || event.id || '';

    if (!(await this.dedup.claim(eventKey))) {
      this.logger.debug(`Dropping duplicate outbox event ${eventKey} (already broadcast)`);
      return;
    }

    if (event.type.startsWith('gig.')) {
      this.emitMilestoneUpdate(event.aggregateId, event.type, event.payload);
    } else if (event.type.startsWith('deliverable.')) {
      this.emitDeliverableUploaded(event.aggregateId, event.type, event.payload);
    }
  }

  /**
   * Resolves once every message queued so far has been processed. Exposed for tests, which
   * otherwise have to poll for a side effect that is now behind a promise chain.
   */
  async whenIdle(): Promise<void> {
    await this.queue;
  }

  handleConnection(client: Socket) {
    // A client that connected after a drain began would never be closed by the sweep above,
    // so refuse it explicitly with the same reason code.
    if (this.draining) {
      client.emit('server:shutdown', { reason: 'server shutting down', reconnect: true });
      client.disconnect(true);
      return;
    }
    this.clients.set(client.id, client);
    this.logger.log(`Client connected: ${client.id} (${this.clients.size} total)`);
  }

  handleDisconnect(client: Socket) {
    this.clients.delete(client.id);
    this.logger.log(`Client disconnected: ${client.id} (${this.clients.size} remaining)`);
  }

  @SubscribeMessage('subscribe:gig')
  handleSubscribeGig(@ConnectedSocket() client: Socket, @MessageBody() data: { gigId: string }) {
    void client.join(`gig:${data.gigId}`);
    return { event: 'subscribed', data: { gigId: data.gigId } };
  }

  @SubscribeMessage('unsubscribe:gig')
  handleUnsubscribeGig(@ConnectedSocket() client: Socket, @MessageBody() data: { gigId: string }) {
    void client.leave(`gig:${data.gigId}`);
    return { event: 'unsubscribed', data: { gigId: data.gigId } };
  }

  emitMilestoneUpdate(gigId: string, type: string, data: unknown) {
    if (this.draining) return;
    const payload: ClientEventPayload = { v: 1, type, data };
    this.server?.to(`gig:${gigId}`).emit('milestone:update', payload);
  }

  emitDeliverableUploaded(gigId: string, type: string, data: unknown) {
    if (this.draining) return;
    const payload: ClientEventPayload = { v: 1, type, data };
    this.server?.to(`gig:${gigId}`).emit('deliverable:uploaded', payload);
  }
}
