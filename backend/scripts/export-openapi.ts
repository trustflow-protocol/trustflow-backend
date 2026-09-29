import '../src/config/load-dotenv.bootstrap';
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { buildOpenApiDocument } from '../src/app.setup';
import { validateEnv } from '../src/config/env.config';

/**
 * Generates openapi.json from the same DocumentBuilder chain the running server serves at
 * /api/docs-json, without listening on a port. Used to check the OpenAPI document into the
 * repo (or upload it as a CI artifact) so route/schema drift shows up in a PR diff — see
 * openapi.snapshot.spec.ts for the automated check.
 */
async function main() {
  validateEnv();
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const document = buildOpenApiDocument(app);
  const outPath = resolve(__dirname, '../openapi.json');
  writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`);

  await app.close();
  // eslint-disable-next-line no-console
  console.log(`OpenAPI document written to ${outPath}`);
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    // eslint-disable-next-line no-console
    console.error('Failed to export OpenAPI document:', error);
    process.exit(1);
  });
