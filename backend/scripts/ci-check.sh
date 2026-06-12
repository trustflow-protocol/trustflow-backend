#!/bin/bash

# CI Check Script
# Run this locally to verify all CI checks will pass before pushing

set -e  # Exit on any error

echo "🔍 TrustFlow Backend - CI Check"
echo "================================"
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

FAILED=0

# Function to run check
run_check() {
    local name=$1
    local command=$2
    
    echo -e "${YELLOW}Running: $name${NC}"
    if eval "$command"; then
        echo -e "${GREEN}✅ $name passed${NC}"
        echo ""
        return 0
    else
        echo -e "${RED}❌ $name failed${NC}"
        echo ""
        FAILED=1
        return 1
    fi
}

# Check if we're in the backend directory
if [ ! -f "package.json" ]; then
    echo -e "${RED}Error: Must run from backend directory${NC}"
    exit 1
fi

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}node_modules not found. Installing dependencies...${NC}"
    npm install
    echo ""
fi

# Run all CI checks
run_check "Lint Check" "npm run lint:check"
run_check "Format Check" "npm run format:check"
run_check "Unit Tests" "npm run test:ci"
run_check "TypeScript Build" "npm run build"
run_check "TypeScript Type Check" "npx tsc --noEmit"

# Summary
echo "================================"
if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}✅ All CI checks passed!${NC}"
    echo "Your code is ready to push."
    exit 0
else
    echo -e "${RED}❌ Some CI checks failed${NC}"
    echo ""
    echo "To fix issues:"
    echo "  - Lint:   npm run lint"
    echo "  - Format: npm run format"
    echo "  - Tests:  npm test"
    exit 1
fi
