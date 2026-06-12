# GitHub Actions CI/CD

This directory contains GitHub Actions workflow configurations for the TrustFlow Backend.

## Workflows

### Backend CI (`backend-ci.yml`)

Automatically runs on:

- **Pull Requests** that modify files in `backend/` directory
- **Push to main/develop** branches with backend changes

#### What it does:

**Test Job** (Matrix: Node 18.x, 20.x)

- ✅ Runs ESLint checks
- ✅ Validates code formatting with Prettier
- ✅ Executes Jest test suite
- ✅ Generates code coverage reports
- ✅ Uploads coverage to Codecov (Node 20.x only)

**Build Job** (Node 20.x)

- ✅ Compiles TypeScript code
- ✅ Checks for TypeScript errors
- ✅ Validates build succeeds

**Status Check Job**

- ✅ Verifies all previous jobs passed
- ❌ Fails the PR if any check fails

#### Timeout

- Maximum 10 minutes per job
- Prevents stuck builds from consuming CI minutes

#### CI Performance Target

- ⏱️ Target: Under 3 minutes per PR
- Current typical runtime: 2-4 minutes

## Branch Protection Rules (Recommended)

To enforce CI checks, configure these branch protection rules for `main`:

1. **Require status checks to pass before merging**
   - ✅ Backend CI / Test Backend (20.x)
   - ✅ Backend CI / Build Backend
   - ✅ Backend CI / CI Status Check

2. **Require branches to be up to date before merging**

3. **Require linear history** (optional)

## Local Testing

Before pushing, run these commands locally to catch issues early:

```bash
cd backend

# Install dependencies
npm install

# Run linter
npm run lint

# Check formatting
npm run format:check

# Run tests
npm test

# Run full CI suite locally
npm run test:ci && npm run build
```

## Troubleshooting

### Build Fails on `npm ci`

**Problem**: Missing `package-lock.json`

**Solution**:

```bash
cd backend
npm install
git add package-lock.json
git commit -m "Add package-lock.json"
```

### Linter Errors

**Problem**: Code doesn't pass ESLint checks

**Solution**:

```bash
npm run lint  # Auto-fix issues
```

### Formatting Errors

**Problem**: Code formatting doesn't match Prettier rules

**Solution**:

```bash
npm run format  # Auto-format code
```

### Test Failures

**Problem**: Tests fail in CI but pass locally

**Possible causes**:

- Environment differences (Node version)
- Missing environment variables
- Race conditions in async tests
- Timezone differences

**Solution**:

```bash
# Test with same Node version as CI
nvm use 20
npm run test:ci
```

### TypeScript Errors

**Problem**: Build fails with TypeScript compilation errors

**Solution**:

```bash
npx tsc --noEmit  # Check for errors without building
```

### Coverage Threshold Not Met

**Problem**: Code coverage below 50% threshold

**Solution**: Add more tests or adjust threshold in `package.json`:

```json
"coverageThreshold": {
  "global": {
    "branches": 50,
    "functions": 50,
    "lines": 50,
    "statements": 50
  }
}
```

## CI Minutes Optimization

Current optimizations:

- ✅ Path filtering (only runs on backend changes)
- ✅ npm cache for faster installs
- ✅ 10 minute timeout prevents runaway jobs
- ✅ Parallel test matrix (Node 18 & 20 in parallel)
- ✅ `--maxWorkers=2` for Jest in CI mode

## Adding Codecov (Optional)

To enable code coverage reporting:

1. Sign up at [codecov.io](https://codecov.io)
2. Add your repository
3. Get the upload token
4. Add `CODECOV_TOKEN` to GitHub repository secrets:
   - Settings → Secrets and variables → Actions → New repository secret

Coverage reports will appear as comments on PRs.

## Future Enhancements

- [ ] E2E integration tests with test database
- [ ] Security scanning with Snyk or Dependabot
- [ ] Automated dependency updates
- [ ] Performance benchmarking
- [ ] Docker image build and push
- [ ] Staging deployment on merge to develop
- [ ] Production deployment on release tags
