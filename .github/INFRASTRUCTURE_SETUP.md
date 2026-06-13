# Infrastructure Setup Guide

Complete guide for configuring the TrustFlow backend infrastructure after merging Path A.

---

## 1️⃣ Configure Branch Protection Rules

### Via GitHub Web UI (Recommended)

1. **Navigate to Settings**
   - Go to: https://github.com/trustflow-protocol/trustflow-backend/settings/branches
   - Or: Repository → Settings → Branches

2. **Add Branch Protection Rule**
   - Click "Add rule" or "Add branch protection rule"
   - Branch name pattern: `main`

3. **Configure Protection Settings**

   #### ✅ Protect matching branches
   - [x] **Require a pull request before merging**
     - [x] Require approvals: **1**
     - [x] Dismiss stale pull request approvals when new commits are pushed
     - [x] Require review from Code Owners

   #### ✅ Require status checks to pass before merging
   - [x] Require branches to be up to date before merging
   - **Search and select these status checks**:
     - `Backend CI / Test Backend (20.x)`
     - `Backend CI / Build Backend`
     - `Backend CI / CI Status Check`

   > **Note**: These checks will only appear after the first PR triggers the CI workflow. If you don't see them yet, create a test PR first.

   #### ✅ Additional Settings
   - [x] **Require linear history** (keeps git history clean)
   - [x] **Do not allow bypassing the above settings** (optional, for strict enforcement)
   - [ ] **Allow force pushes** (keep unchecked)
   - [ ] **Allow deletions** (keep unchecked)

4. **Save Changes**
   - Click "Create" or "Save changes"

### Verification

After setup, you should see:

```
✅ Require a pull request before merging
✅ Require status checks to pass before merging
✅ Require linear history
```

### Alternative: Via GitHub CLI (Advanced)

If you prefer command line, you can use the GitHub web interface is more reliable for branch protection.

---

## 2️⃣ Set Up Discord Webhook

### Create Discord Webhook

1. **Open Discord Server**
   - Go to your TrustFlow community Discord server

2. **Create Webhook**
   - Right-click the channel where notifications should appear
   - Select "Edit Channel"
   - Go to "Integrations" tab
   - Click "Webhooks" → "New Webhook"

3. **Configure Webhook**
   - Name: `TrustFlow Dispute Notifications`
   - Channel: Select the appropriate channel (e.g., #disputes or #alerts)
   - Avatar: Upload TrustFlow logo (optional)
   - Click "Copy Webhook URL"

### Add to Environment

```bash
cd backend

# Create .env if it doesn't exist
cp ../.env.example .env

# Edit .env and add your webhook URL
# DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN
```

Or add directly:

```bash
echo "DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_ID/YOUR_TOKEN" >> backend/.env
```

### Test Discord Integration

#### Option 1: Run Test Script

```bash
cd backend

# Make sure dependencies are installed
npm install

# Run the automated test script
./src/webhook/examples/test-discord-integration.sh
```

#### Option 2: Manual Test

```bash
# Start backend server
cd backend
npm run dev

# In another terminal, create an escrow
curl -X POST http://localhost:3001/escrows \
  -H "Content-Type: application/json" \
  -d '{
    "depositor": "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "beneficiary": "GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY",
    "amountXLM": "500"
  }'

# Note the escrow ID from response, then raise a dispute
curl -X POST http://localhost:3001/escrows/YOUR_ESCROW_ID/dispute \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Testing Discord integration - deliverable not as specified"
  }'
```

### Verify in Discord

Check your Discord channel for a message like:

```
@here A new dispute needs your attention!

⚖️ New Dispute Requires Jurors
A dispute has been raised and requires community jurors to resolve.

Escrow ID: esc-1234567890
Amount: 500 XLM
Depositor: GXXXXX...XXXX
Beneficiary: GYYYYY...YYYY
Reason: Testing Discord integration - deliverable not as specified
```

### Troubleshooting Discord

**Issue: No message appears**

- ✅ Check `.env` file has `DISCORD_WEBHOOK_URL` set correctly
- ✅ Verify webhook URL format: `https://discord.com/api/webhooks/ID/TOKEN`
- ✅ Check backend server logs for errors
- ✅ Test webhook with curl:
  ```bash
  curl -X POST "YOUR_WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d '{"content":"Test message from TrustFlow"}'
  ```

**Issue: Webhook URL invalid**

- ✅ Copy webhook URL again from Discord
- ✅ Ensure no extra spaces or characters
- ✅ URL should start with `https://discord.com/api/webhooks/`

**Issue: Backend not starting**

- ✅ Run `npm install` in backend directory
- ✅ Check Node.js version: `node -v` (should be 18+ or 20+)
- ✅ Check for port conflicts (default: 3001)

---

## 3️⃣ Update CODEOWNERS

### Why Update CODEOWNERS?

The CODEOWNERS file automatically requests reviews from specific people when code in certain paths is modified. This ensures the right people review the right changes.

### Find Your Team Members

```bash
# List repository collaborators
gh api repos/trustflow-protocol/trustflow-backend/collaborators --jq '.[].login'

# Or list organization teams (if using GitHub org)
gh api orgs/trustflow-protocol/teams --jq '.[].name'
```

### Update the File

Edit `.github/CODEOWNERS`:

```bash
# Open in your editor
code .github/CODEOWNERS
# or
nano .github/CODEOWNERS
```

**Current (Placeholder)**:

```
# Default owner
* @meshackyaro

# Backend specific
/backend/ @meshackyaro
```

**Example Update (With Team)**:

```
# Default owner
* @trustflow-maintainers

# Backend specific - requires backend team review
/backend/ @meshackyaro @contributor1 @contributor2

# CI/CD - requires DevOps review
/.github/ @meshackyaro @devops-lead

# Documentation - anyone can review
*.md @meshackyaro @contributor1

# Critical config - requires senior review
.env* @meshackyaro
package.json @meshackyaro
tsconfig.json @meshackyaro
```

**Example Update (With Org Teams)**:

```
# Default owner
* @trustflow-protocol/core-team

# Backend specific
/backend/ @trustflow-protocol/backend-team

# CI/CD
/.github/ @trustflow-protocol/devops-team

# Documentation
*.md @trustflow-protocol/docs-team
```

### Commit Changes

```bash
git add .github/CODEOWNERS
git commit -m "chore: update CODEOWNERS with team members"
git push origin main
```

### Verify CODEOWNERS Works

1. Create a test branch:

   ```bash
   git checkout -b test/codeowners
   ```

2. Make a small change to backend:

   ```bash
   echo "# Test" >> backend/README.md
   git add backend/README.md
   git commit -m "test: verify CODEOWNERS"
   git push -u origin test/codeowners
   ```

3. Create PR:

   ```bash
   gh pr create --title "Test: Verify CODEOWNERS" --body "Testing CODEOWNERS configuration"
   ```

4. Check PR on GitHub:
   - Should see "Reviewers" automatically populated
   - Should see "Review required from code owners"

5. Close test PR:
   ```bash
   gh pr close --delete-branch
   ```

---

## 4️⃣ Optional: Set Up Codecov

### Why Codecov?

Codecov provides:

- Code coverage visualization
- Coverage reports on PRs
- Coverage trends over time
- Coverage badges for README

### Setup Steps

1. **Sign Up**
   - Go to https://codecov.io
   - Sign in with GitHub
   - Authorize Codecov

2. **Add Repository**
   - Click "Add new repository"
   - Find `trustflow-protocol/trustflow-backend`
   - Click "Setup repo"

3. **Get Upload Token**
   - Copy the upload token shown
   - Or find it in: Settings → General → Repository Upload Token

4. **Add to GitHub Secrets**

   ```bash
   # Via GitHub CLI
   gh secret set CODECOV_TOKEN
   # Paste your token when prompted
   ```

   Or via Web UI:
   - Go to: Repository → Settings → Secrets and variables → Actions
   - Click "New repository secret"
   - Name: `CODECOV_TOKEN`
   - Value: [paste your token]
   - Click "Add secret"

5. **Verify**
   - Create a new PR
   - CI should upload coverage to Codecov
   - Check https://codecov.io/gh/trustflow-protocol/trustflow-backend

6. **Add Badge to README** (Optional)
   - Get badge markdown from Codecov settings
   - Add to `README.md`:
   ```markdown
   [![codecov](https://codecov.io/gh/trustflow-protocol/trustflow-backend/branch/main/graph/badge.svg)](https://codecov.io/gh/trustflow-protocol/trustflow-backend)
   ```

---

## 5️⃣ Verification Checklist

### Branch Protection

- [ ] Main branch has protection rules enabled
- [ ] Requires 1 approval before merging
- [ ] Requires CI checks to pass
- [ ] Linear history enabled
- [ ] Test PR shows "Merging is blocked"

### Discord Integration

- [ ] Webhook URL added to `.env`
- [ ] Backend server starts without errors
- [ ] Test script runs successfully
- [ ] Message appears in Discord channel
- [ ] Message format is correct (embed, not plain text)

### CODEOWNERS

- [ ] File updated with real usernames/teams
- [ ] All critical paths covered
- [ ] Test PR auto-requests reviewers
- [ ] "Review from code owners" requirement shows

### Codecov (Optional)

- [ ] Repository added to Codecov
- [ ] CODECOV_TOKEN added to secrets
- [ ] PR shows coverage report
- [ ] Coverage badge in README

---

## 🎉 Completion

Once all steps are complete, your infrastructure is production-ready:

✅ **Quality Gates**: CI blocks broken code  
✅ **Review Process**: CODEOWNERS ensures proper review  
✅ **Community Alerts**: Discord notifies on disputes  
✅ **Coverage Tracking**: Codecov monitors test coverage

### What's Next?

You can now:

1. **Accept external contributions** with confidence
2. **Deploy to production** knowing CI validates everything
3. **Move to next features** (#36, #46, #47, etc.)
4. **Scale the team** with defined processes

---

## 📚 Additional Resources

- [Branch Protection Docs](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [CODEOWNERS Syntax](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)
- [Discord Webhooks Guide](https://discord.com/developers/docs/resources/webhook)
- [Codecov Documentation](https://docs.codecov.com/docs)
- [GitHub Actions Secrets](https://docs.github.com/en/actions/security-guides/encrypted-secrets)

---

**Questions?** Check the documentation files:

- `backend/SETUP_INSTRUCTIONS.md` - Development setup
- `.github/workflows/README.md` - CI/CD guide
- `backend/src/webhook/DISCORD_INTEGRATION.md` - Discord setup details
