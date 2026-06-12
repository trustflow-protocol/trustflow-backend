#!/bin/bash

# Test Discord Integration Script
# This script demonstrates how to test the Discord bot integration
# Make sure your backend is running and DISCORD_WEBHOOK_URL is configured

BASE_URL="${BASE_URL:-http://localhost:3001}"

echo "🚀 Testing TrustFlow Discord Integration"
echo "========================================="
echo ""

# Step 1: Create an escrow
echo "📝 Step 1: Creating an escrow..."
ESCROW_RESPONSE=$(curl -s -X POST "$BASE_URL/escrows" \
  -H "Content-Type: application/json" \
  -d '{
    "depositor": "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "beneficiary": "GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY",
    "amountXLM": "500"
  }')

ESCROW_ID=$(echo "$ESCROW_RESPONSE" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)

if [ -z "$ESCROW_ID" ]; then
  echo "❌ Failed to create escrow"
  echo "Response: $ESCROW_RESPONSE"
  exit 1
fi

echo "✅ Escrow created with ID: $ESCROW_ID"
echo ""

# Wait a moment
sleep 1

# Step 2: Raise a dispute
echo "⚖️  Step 2: Raising a dispute..."
DISPUTE_RESPONSE=$(curl -s -X POST "$BASE_URL/escrows/$ESCROW_ID/dispute" \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "The deliverable did not meet the agreed specifications. Freelancer submitted incomplete work."
  }')

echo "✅ Dispute raised successfully!"
echo "Response: $DISPUTE_RESPONSE"
echo ""

# Step 3: Verify the escrow status
echo "🔍 Step 3: Verifying escrow status..."
STATUS_RESPONSE=$(curl -s -X GET "$BASE_URL/escrows/$ESCROW_ID")
echo "Current Status: $STATUS_RESPONSE"
echo ""

echo "✨ Test complete!"
echo ""
echo "Check your Discord channel for the notification message:"
echo "  - Title: ⚖️ New Dispute Requires Jurors"
echo "  - Contains: Escrow ID, Amount, Addresses, Reason"
echo "  - Mention: @here notification"
echo ""
echo "If you don't see a message, verify:"
echo "  1. DISCORD_WEBHOOK_URL is set in your .env"
echo "  2. The webhook URL is valid"
echo "  3. Check backend logs for any errors"
