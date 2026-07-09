import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { GigModule } from './gig.module';
import { GigStatus } from './gig.entity';

const clientAddress = `G${'A'.repeat(55)}`;

describe('GigController', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [GigModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const validPayload = {
    clientAddress,
    title: 'Build a Soroban escrow dashboard',
    description: 'Create a dashboard for tracking escrow milestones and gig delivery state.',
    budgetXLM: '250.0000000',
    category: 'development',
    skills: ['NestJS', 'Soroban'],
  };

  it('creates, reads, updates, closes, and deletes a gig listing', async () => {
    const createResponse = await request(app.getHttpServer())
      .post('/gigs')
      .send(validPayload)
      .expect(201);

    expect(createResponse.body).toMatchObject({
      clientAddress,
      title: validPayload.title,
      status: GigStatus.OPEN,
    });

    const id = createResponse.body.id as string;

    await request(app.getHttpServer())
      .get('/gigs')
      .query({ clientAddress, status: GigStatus.OPEN, skill: 'soroban' })
      .expect(200)
      .expect(response => {
        expect(response.body).toHaveLength(1);
        expect(response.body[0].id).toBe(id);
      });

    await request(app.getHttpServer())
      .get(`/gigs/${id}`)
      .expect(200)
      .expect(response => {
        expect(response.body.id).toBe(id);
      });

    await request(app.getHttpServer())
      .patch(`/gigs/${id}`)
      .send({ title: 'Build an escrow analytics dashboard' })
      .expect(200)
      .expect(response => {
        expect(response.body.title).toBe('Build an escrow analytics dashboard');
      });

    await request(app.getHttpServer())
      .post(`/gigs/${id}/close`)
      .expect(201)
      .expect(response => {
        expect(response.body.status).toBe(GigStatus.CLOSED);
        expect(response.body.closedAt).toBeDefined();
      });

    await request(app.getHttpServer()).delete(`/gigs/${id}`).expect(204);
    await request(app.getHttpServer()).get(`/gigs/${id}`).expect(404);
  });

  it('returns 400 for invalid create payloads and query filters', async () => {
    await request(app.getHttpServer())
      .post('/gigs')
      .send({ ...validPayload, clientAddress: 'bad-address' })
      .expect(400)
      .expect(response => {
        expect(response.body.message).toBe('Invalid gig listing payload');
      });

    await request(app.getHttpServer()).get('/gigs').query({ status: 'archived' }).expect(400);
  });
});
