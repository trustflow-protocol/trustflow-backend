# Backend Setup Instructions

## Quick Start

### 1. Install Dependencies

```bash
cd backend
npm install
```

This will install all required dependencies including:

- NestJS framework
- Testing libraries (Jest, Supertest)
- TypeScript and build tools
- Linting tools (ESLint, Prettier)

**Note**: Initial install may take 3-5 minutes depending on your connection.

### 2. Environment Configuration

Copy the example environment file and configure it:

```bash
cp ../.env.example .env
```

Edit `.env` and set your values:

```env
STELLAR_NETWORK=TESTNET
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
TRUSTFLOW_CONTRACT_ID=your_contract_id
JWT_SECRET=your_secure_secret_here
PORT=3001
DISCORD_WEBHOOK_URL=your_discord_webhook_url  # Optional
```

### 3. Verify Installation

Run the local CI check to ensure everything is set up correctly:

```bash
./scripts/ci-check.sh
```

This will run:

- ✅ Linting checks
- ✅ Code formatting validation
- ✅ Unit tests with coverage
- ✅ TypeScript build
- ✅ Type checking

## Development Workflow

### Running in Development Mode

```bash
npm run dev
```

This starts the server with hot reload on file changes.

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:cov

# Run tests in CI mode
npm run test:ci
```

### Code Quality

```bash
# Auto-fix linting issues
npm run lint

# Check linting without fixing
npm run lint:check

# Auto-format code
npm run format

# Check formatting without fixing
npm run format:check
```

### Building for Production

```bash
# Build TypeScript
npm run build

# Run production build
npm start
```

## Project Structure

```
backend/
├── src/
│   ├── auth/              # JWT authentication
│   ├── escrow/            # Escrow management
│   ├── stellar/           # Stellar blockchain integration
│   ├── webhook/           # Webhook system & Discord
│   ├── monitoring/        # Health checks & metrics
│   └── index.ts           # App entry point
├── scripts/
│   └── ci-check.sh        # Local CI verification
├── dist/                  # Build output (generated)
├── coverage/              # Test coverage reports (generated)
├── node_modules/          # Dependencies (generated)
├── package.json           # Dependencies & scripts
├── tsconfig.json          # TypeScript configuration
├── .eslintrc.js           # ESLint configuration
└── .prettierrc            # Prettier configuration
```

## Common Commands

| Command                 | Description                              |
| ----------------------- | ---------------------------------------- |
| `npm run dev`           | Start development server with hot reload |
| `npm test`              | Run tests                                |
| `npm run test:watch`    | Run tests in watch mode                  |
| `npm run test:cov`      | Run tests with coverage report           |
| `npm run lint`          | Auto-fix linting issues                  |
| `npm run format`        | Auto-format code                         |
| `npm run build`         | Build for production                     |
| `npm start`             | Run production build                     |
| `./scripts/ci-check.sh` | Run all CI checks locally                |

## Troubleshooting

### Issue: `npm install` fails

**Solutions**:

1. Clear npm cache: `npm cache clean --force`
2. Delete `node_modules` and `package-lock.json`, then retry
3. Check Node.js version: `node -v` (should be 18.x or 20.x)
4. Try using `npm install --legacy-peer-deps`

### Issue: Port 3001 already in use

**Solution**: Change the port in `.env`:

```env
PORT=3002
```

### Issue: TypeScript errors

**Solution**: Ensure TypeScript is installed globally or use npx:

```bash
npx tsc --version
```

### Issue: Tests fail locally but pass in CI (or vice versa)

**Causes**:

- Different Node.js versions
- Missing environment variables
- Timezone differences

**Solution**:

```bash
# Use same Node version as CI
nvm use 20
npm run test:ci
```

### Issue: Module not found errors

**Solution**: Rebuild dependencies:

```bash
rm -rf node_modules package-lock.json
npm install
```

## CI/CD

The project uses GitHub Actions for continuous integration. Every PR that modifies backend code automatically runs:

1. **Linting** - ESLint checks
2. **Formatting** - Prettier validation
3. **Tests** - Jest test suite with coverage
4. **Build** - TypeScript compilation
5. **Type Check** - TypeScript type validation

See [CI_SETUP_SUMMARY.md](CI_SETUP_SUMMARY.md) for detailed CI documentation.

### Before Pushing

Always run the local CI check:

```bash
./scripts/ci-check.sh
```

This catches issues before they reach CI, saving time and CI minutes.

## Next Steps

1. ✅ Run `npm install`
2. ✅ Copy and configure `.env`
3. ✅ Run `./scripts/ci-check.sh` to verify setup
4. ✅ Start development: `npm run dev`
5. ✅ Make your changes
6. ✅ Run tests: `npm test`
7. ✅ Push and create PR

## Additional Resources

- [Discord Integration Setup](src/webhook/DISCORD_INTEGRATION.md)
- [CI/CD Documentation](.github/workflows/README.md)
- [Main README](../README.md)
