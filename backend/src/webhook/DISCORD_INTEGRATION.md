# Discord Bot Integration

This integration sends webhook notifications to a Discord channel whenever a dispute is raised and needs jurors.

## Setup

### 1. Create a Discord Webhook

1. Open your Discord server
2. Go to Server Settings → Integrations → Webhooks
3. Click "New Webhook"
4. Name it (e.g., "TrustFlow Dispute Notifications")
5. Select the channel where notifications should appear
6. Copy the Webhook URL

### 2. Configure Environment Variable

Add the Discord webhook URL to your `.env` file:

```env
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN
```

### 3. Test the Integration

Create an escrow and raise a dispute:

```bash
# Create an escrow
curl -X POST http://localhost:3001/escrows \
  -H "Content-Type: application/json" \
  -d '{
    "depositor": "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "beneficiary": "GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY",
    "amountXLM": "100"
  }'

# Raise a dispute (use the escrow ID from the response above)
curl -X POST http://localhost:3001/escrows/{escrow-id}/dispute \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Work not delivered as specified"
  }'
```

## Discord Message Format

When a dispute is raised, the following embed will be sent to Discord:

- **Title**: ⚖️ New Dispute Requires Jurors
- **Description**: A dispute has been raised and requires community jurors to resolve
- **Fields**:
  - Escrow ID
  - Amount (in XLM)
  - Depositor address (truncated)
  - Beneficiary address (truncated)
  - Reason (if provided)
- **Mention**: @here tag to notify online members

## Features

- ✅ Automatic Discord notifications when disputes are raised
- ✅ Rich embed formatting with color-coded alerts
- ✅ Truncated wallet addresses for readability
- ✅ Optional dispute reason included in notification
- ✅ Timestamp of dispute
- ✅ Falls back gracefully if webhook URL is not configured

## Error Handling

- If `DISCORD_WEBHOOK_URL` is not set, a warning is logged and the notification is skipped
- If the Discord API fails, an error is logged but the dispute is still recorded
- The notification system is non-blocking and won't affect the dispute creation process

## Integration with Webhook System

The Discord notification works alongside the general webhook system:

1. **Webhook Event**: `dispute.raised` event is dispatched to all registered webhooks
2. **Discord Notification**: Specific Discord message is sent to the configured channel

Both happen simultaneously when a dispute is raised.
