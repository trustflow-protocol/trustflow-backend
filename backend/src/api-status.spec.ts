import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import { EscrowController } from './escrow/escrow.controller';
import { EscrowService } from './escrow/escrow.service';
import { EscrowReleaseTransactionBuilderService } from './escrow-write/escrow-release-transaction-builder.service';
import { DisputeSagaController } from './dispute/dispute-saga.controller';
import { DisputeSagaService } from './dispute/dispute-saga.service';
import { GigController } from './gig/gig.controller';
import { GigService } from './gig/gig.service';
import { IpfsPinningController } from './ipfs-pinning/ipfs-pinning.controller';
import { IpfsPinningService } from './ipfs-pinning/ipfs-pinning.service';
import { JwtAuthGuard } from './auth/auth.guard';

describe('Controller status codes match OpenAPI responses', () => {
  let app: INestApplication;
  let document: ReturnType<typeof SwaggerModule.createDocument>;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [EscrowController, DisputeSagaController, GigController, IpfsPinningController],
      providers: [
        {
          provide: EscrowService,
          useValue: {
            release: jest.fn().mockResolvedValue({}),
            raiseDispute: jest.fn().mockResolvedValue({}),
          },
        },
        { provide: EscrowReleaseTransactionBuilderService, useValue: {} },
        {
          provide: DisputeSagaService,
          useValue: {
            assignJurors: jest.fn().mockResolvedValue({}),
            castVote: jest.fn().mockResolvedValue({}),
            executePayout: jest.fn().mockResolvedValue({}),
          },
        },
        {
          provide: GigService,
          useValue: {
            accept: jest.fn().mockResolvedValue({}),
            cancel: jest.fn().mockResolvedValue({}),
          },
        },
        { provide: IpfsPinningService, useValue: { reconcile: jest.fn().mockResolvedValue({}) } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = module.createNestApplication();
    document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('status test').setVersion('1').build(),
    );
    await app.init();
  });

  afterAll(async () => app.close());

  const cases = [
    ['post', '/escrows/test-id/release', '/escrows/{id}/release', undefined, 200],
    ['post', '/escrows/test-id/dispute', '/escrows/{id}/dispute', { reason: 'test' }, 200],
    ['post', '/dispute/test-id/assign-jurors', '/dispute/{sagaId}/assign-jurors', {}, 200],
    ['post', '/dispute/test-id/vote', '/dispute/{sagaId}/vote', {}, 200],
    ['post', '/dispute/test-id/payout', '/dispute/{sagaId}/payout', {}, 200],
    ['post', '/gigs/test-id/accept', '/gigs/{id}/accept', { responder: `G${'A'.repeat(55)}` }, 200],
    ['post', '/gigs/test-id/cancel', '/gigs/{id}/cancel', undefined, 200],
    ['post', '/ipfs/pins/bafkreitest/verify', '/ipfs/pins/{cid}/verify', undefined, 200],
  ] as const;

  it.each(cases)(
    '%s %s returns and documents response %s',
    async (method, path, openApiPath, body, status) => {
      const responseKey = String(status);
      const apiOperation = document.paths[openApiPath]?.[method as 'post'];

      const operationStatuses = Object.keys(apiOperation?.responses ?? {});
      expect(operationStatuses).toContain(responseKey);

      const req = request(app.getHttpServer())[method](path);
      if (body) req.send(body);
      await req.expect(status);
    },
  );
});
