import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './app.module';
import { buildOpenApiDocument } from './app.setup';
import { validateEnv } from './config/env.config';

// buildOpenApiDocument() reads config.API_URL — requires validateEnv() to have run first.
validateEnv();

/**
 * Fails the moment a route or DTO/schema changes without the author noticing — the exact
 * drift #477 set out to catch, since previously nothing compared the generated OpenAPI
 * document against anything. Update the snapshot (`jest -u`) as part of the same PR that
 * intentionally changes a route or schema, and treat an unexpected diff as a signal to
 * double check the change was intended.
 */
describe('OpenAPI document', () => {
  it('matches the checked-in snapshot', async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = moduleFixture.createNestApplication();
    await app.init();

    const document = buildOpenApiDocument(app);

    expect(document).toMatchSnapshot();

    await app.close();
  });
});
