# Webhook Signature Verification Guide

TrustFlow uses HMAC-SHA256 signatures to allow webhook consumers to verify that incoming webhook payloads originate from TrustFlow Core and have not been tampered with or forged in transit.

---

## 1. Registering a Webhook with a Secret

When registering a webhook endpoint via `POST /webhooks`, you can supply an optional `secret` field (minimum 16 characters):

```http
POST /webhooks
Content-Type: application/json

{
  "id": "my-service-webhook",
  "url": "https://api.example.com/webhooks/trustflow",
  "events": ["escrow.created", "escrow.released", "dispute.raised", "dispute.resolved"],
  "secret": "your-secure-shared-secret-at-least-16-chars"
}
```

- **With Secret**: TrustFlow computes an HMAC-SHA256 signature of the raw request body using this secret and attaches it to the `X-TrustFlow-Signature` HTTP header on every dispatched event.
- **Without Secret (Unsigned)**: If no secret is provided during registration, webhook payloads will be delivered without the `X-TrustFlow-Signature` header.

---

## 2. Signature Specification

- **Header Name**: `X-TrustFlow-Signature`
- **Algorithm**: `HMAC-SHA256`
- **Encoding**: Hexadecimal (`[0-9a-f]{64}`)
- **Input**: The raw, unparsed UTF-8 JSON payload body as received over HTTP.

---

## 3. Verifying Signatures

> [!IMPORTANT]
> You must compute the HMAC over the **raw request body buffer/string before any JSON parsing or modification**. Key reordering or whitespace changes will alter the signature. Always use constant-time comparison (such as `crypto.timingSafeEqual` in Node.js or `hmac.compare_digest` in Python) to prevent timing attacks.

### Node.js / Express Example

```typescript
import express, { Request, Response } from 'express';
import * as crypto from 'crypto';

const app = express();
const WEBHOOK_SECRET = process.env.TRUSTFLOW_WEBHOOK_SECRET || 'your-secure-shared-secret-at-least-16-chars';

// Capture the raw body buffer for signature verification
app.post(
  '/webhooks/trustflow',
  express.raw({ type: 'application/json' }),
  (req: Request, res: Response) => {
    const signatureHeader = req.headers['x-trustflow-signature'] as string | undefined;

    if (!signatureHeader) {
      return res.status(401).json({ error: 'Missing X-TrustFlow-Signature header' });
    }

    const rawBody = req.body.toString('utf8');
    const expectedSignature = crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(rawBody, 'utf8')
      .digest('hex');

    // Constant-time comparison to prevent timing attacks
    const signatureBuffer = Buffer.from(signatureHeader, 'hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');

    if (
      signatureBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
    ) {
      return res.status(403).json({ error: 'Invalid webhook signature' });
    }

    // Parse verified payload
    const event = JSON.parse(rawBody);
    console.log('Received verified TrustFlow webhook:', event);

    // Process event...
    return res.status(200).json({ received: true });
  },
);

app.listen(3000, () => console.log('Webhook receiver running on port 3000'));
```

### Python / FastAPI Example

```python
import hmac
import hashlib
import os
from fastapi import FastAPI, Header, HTTPException, Request

app = FastAPI()
WEBHOOK_SECRET = os.getenv("TRUSTFLOW_WEBHOOK_SECRET", "your-secure-shared-secret-at-least-16-chars").encode("utf-8")

@app.post("/webhooks/trustflow")
async def receive_webhook(request: Request, x_trustflow_signature: str = Header(None)):
    if not x_trustflow_signature:
        raise HTTPException(status_code=401, detail="Missing X-TrustFlow-Signature header")

    raw_body = await request.body()
    expected_signature = hmac.new(WEBHOOK_SECRET, raw_body, hashlib.sha256).hexdigest()

    # Constant-time comparison to prevent timing attacks
    if not hmac.compare_digest(x_trustflow_signature, expected_signature):
        raise HTTPException(status_code=403, detail="Invalid webhook signature")

    payload = await request.json()
    print("Received verified TrustFlow webhook:", payload)
    return {"received": True}
```

---

## 4. Payload Format & Event Types

Every outgoing payload has the following structure:

```json
{
  "event": "escrow.created",
  "data": {
    "id": "esc-123",
    "depositor": "G...",
    "beneficiary": "G...",
    "amountXLM": "100.0000000"
  },
  "timestamp": "2026-08-31T22:30:00.000Z",
  "dedupKey": "escrow.created:esc-123"
}
```

### Supported Events

| Event Name | Description |
| :--- | :--- |
| `escrow.created` | Emitted when a new escrow contract is initialized. |
| `escrow.released` | Emitted when escrow funds are released to the beneficiary. |
| `dispute.raised` | Emitted when a party raises a dispute on an active escrow. |
| `dispute.resolved` | Emitted when a dispute is finalized by jurors/arbitrators. |

---

## 5. Best Practices

1. **Verify Raw Body**: Do not parse the JSON payload prior to verifying the signature.
2. **Store Secrets Securely**: Secrets should be stored in environment variables or secret managers, not in version control.
3. **Idempotency & Replay**: Use the `dedupKey` and `timestamp` fields in the payload to detect and discard duplicate deliveries from network retries.
4. **Respond Promptly**: Acknowledge webhooks with a `2xx` HTTP response within 10 seconds to avoid timeout retries. Long-running processing should be offloaded to an asynchronous background worker.
