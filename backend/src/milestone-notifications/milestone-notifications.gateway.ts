import { Logger } from '@nestjs/common';
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

@WebSocketGateway({ cors: { origin: process.env.CORS_ORIGIN || '*' } })
export class MilestoneNotificationsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(MilestoneNotificationsGateway.name);

  @WebSocketServer()
  server!: Server;

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

  emitMilestoneUpdate(gigId: string, payload: Record<string, unknown>) {
    this.server?.to(`gig:${gigId}`).emit('milestone:update', payload);
  }

  emitDeliverableUploaded(gigId: string, payload: Record<string, unknown>) {
    this.server?.to(`gig:${gigId}`).emit('deliverable:uploaded', payload);
  }
}
