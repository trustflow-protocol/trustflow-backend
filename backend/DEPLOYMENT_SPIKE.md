# Backend Container, Release, and Migration Strategy

This spike defines the deployment contract for the TrustFlow backend so releases are repeatable and database/state migrations are handled deliberately.

## Container Image

- Build from `backend/` with Node 20, `npm ci`, `npm run build`, and `npm prune --omit=dev`.
- Run `node dist/main.js` as a non-root user.
- Inject runtime configuration through environment variables validated by `src/config/env.config.ts`; never bake secrets into the image.
- Required production dependencies are PostgreSQL/Redis where configured, Stellar Horizon, Soroban RPC, and `TRUSTFLOW_CONTRACT_ID` for on-chain operations.
- Publish immutable image tags using both the semantic version and commit SHA, for example `trustflow-backend:1.4.0` and `trustflow-backend:<git-sha>`.

## Release Flow

1. Run CI: lint, unit tests, OpenAPI snapshot, and build.
2. Build and scan the container image.
3. Push immutable image tags to the registry.
4. Deploy to staging with production-like Redis, database, Horizon, and Soroban RPC settings.
5. Run smoke checks for `/health`, Swagger exposure policy, JWT auth, event ingestion, and escrow reconciliation.
6. Promote the exact same image digest to production.
7. Monitor metrics, Sentry, worker logs, and Soroban event cursor lag for at least one polling interval.

## Migration Strategy

- Keep application migrations idempotent and registered through the existing `MigrationRunnerService`.
- Prefer forward-only migrations. Rollback plans should be operational playbooks unless the data transform is trivially reversible.
- Run migrations before serving traffic when they change required read/write paths.
- For long-running migrations, use the existing migration state store and resume from checkpoints instead of holding a single process lock forever.
- Schema changes that affect event ingestion or escrow reconciliation must include a backfill plan for existing Redis/database records.

## Rollback Strategy

- Roll back by redeploying the previous immutable image digest.
- Do not roll back data automatically unless the migration explicitly declares a safe reverse operation.
- If a release changes Soroban event decoding or escrow linking, pause ingestion workers before rollback, preserve the cursor, and resume only after the old code has been verified against the stored event schema.

## Open Follow-Ups

- Add a first-party Dockerfile once the target registry and runtime base image are selected.
- Add CI image signing and SBOM publication.
- Add a staged migration command that can run as a one-shot job before the web process starts.
