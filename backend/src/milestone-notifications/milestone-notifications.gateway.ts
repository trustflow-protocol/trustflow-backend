import { Logger, OnModuleInit, OnModuleDestroy, Inject, Optional } from '@nestjs/common';
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

const LRU_MAX_SIZE = 1000;

export interface ClientEventPayload {
  v: number;
  type: string;
  data: unknown;
}

@WebSocketGateway({ cors: { origin: '*' } })
export class MilestoneNotificationsGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MilestoneNotificationsGateway.name);
  private subscriber: Redis | null = null;
  private readonly seenDedupKeys = new Set<string>();
  private readonly dedupQueue: string[] = [];

  constructor(@Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null) {}

  @WebSocketServer()
  server!: Server;

  onModuleInit() {
    if (this.redis) {
      this.subscriber = this.redis.duplicate();
      
      this.subscriber.on('error', err => this.logger.error(`Subscriber Redis error: ${err.message}`));
      this.subscriber.on('connect', () => this.logger.log('Subscriber connected to Redis'));
      
      this.subscriber.subscribe(OUTBOX_GATEWAY_CHANNEL, (err) => {
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
      this.logger.warn('No Redis client provided; running in local mode without outbox subscription');
    }
  }

  onModuleDestroy() {
    if (this.subscriber) {
      this.subscriber.unsubscribe(OUTBOX_GATEWAY_CHANNEL).catch(err => this.logger.error(`Failed to unsubscribe`, err));
      this.subscriber.disconnect();
    }
  }

  private handleOutboxMessage(message: string) {
    try {
      const event = JSON.parse(message) as OutboxEvent;
      
      if (this.seenDedupKeys.has(event.dedupKey)) {
        return; // Drop duplicate
      }
      this.seenDedupKeys.add(event.dedupKey);
      this.dedupQueue.push(event.dedupKey);
      if (this.dedupQueue.length > LRU_MAX_SIZE) {
        const oldest = this.dedupQueue.shift();
        if (oldest) this.seenDedupKeys.delete(oldest);
      }

      if (event.type.startsWith('gig.')) {
        this.emitMilestoneUpdate(event.aggregateId, event.type, event.payload);
      } else if (event.type.startsWith('deliverable.')) {
        this.emitDeliverableUploaded(event.aggregateId, event.type, event.payload);
      }
    } catch (e) {
      this.logger.error('Failed to process outbox message', e);
    }
  }

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('subscribe:gig')
  handleSubscribeGig(@ConnectedSocket() client: Socket, @MessageBody() data: { gigId: string }) {
    client.join(`gig:${data.gigId}`);
    return { event: 'subscribed', data: { gigId: data.gigId } };
  }

  @SubscribeMessage('unsubscribe:gig')
  handleUnsubscribeGig(@ConnectedSocket() client: Socket, @MessageBody() data: { gigId: string }) {
    client.leave(`gig:${data.gigId}`);
    return { event: 'unsubscribed', data: { gigId: data.gigId } };
  }

  emitMilestoneUpdate(gigId: string, type: string, data: unknown) {
    const payload: ClientEventPayload = { v: 1, type, data };
    this.server?.to(`gig:${gigId}`).emit('milestone:update', payload);
  }

  emitDeliverableUploaded(gigId: string, type: string, data: unknown) {
    const payload: ClientEventPayload = { v: 1, type, data };
    this.server?.to(`gig:${gigId}`).emit('deliverable:uploaded', payload);
  }
}
