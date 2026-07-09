# TrustFlow API Documentation

**Version**: 1.0.0  
**License**: MIT

---

## 🚀 Quick Start

### Access Interactive Documentation

Once the server is running, access the Swagger UI at:

```
http://localhost:3001/api/docs
```

### OpenAPI JSON Specification

The raw OpenAPI specification is available at:

```
http://localhost:3001/api/docs-json
```

---

## 📚 API Overview

The TrustFlow Backend API provides off-chain services for the TrustFlow gig economy platform. It handles:

- **Authentication**: Wallet-based JWT authentication using Stellar signatures
- **Escrow Management**: Create, manage, and release escrow vaults
- **Gig Listings**: Publish and manage open gig solicitations
- **Dispute Resolution**: Raise disputes and trigger juror notifications
- **Webhooks**: Register endpoints to receive event notifications
- **Monitoring**: Health checks and Prometheus metrics

---

## 🔐 Authentication

### Wallet-Based Authentication Flow

1. **Get Challenge**: `GET /auth/challenge?address=YOUR_ADDRESS`
   - Receive a challenge message to sign

2. **Sign with Wallet**: Sign the challenge using your Stellar wallet

3. **Verify Signature**: `POST /auth/verify`

   ```json
   {
     "address": "GXXXXX...",
     "signature": "base64_signature..."
   }
   ```

4. **Receive JWT Token**: Use this token in the `Authorization` header
   ```
   Authorization: Bearer YOUR_JWT_TOKEN
   ```

### Using Authentication in Swagger UI

1. Get your challenge and sign it
2. Verify and receive a JWT token
3. Click the 🔒 "Authorize" button in Swagger UI
4. Enter your token (without "Bearer" prefix)
5. All protected endpoints will now include your auth token

---

## 📖 API Endpoints

### Authentication

| Method | Endpoint          | Description                         |
| ------ | ----------------- | ----------------------------------- |
| GET    | `/auth/challenge` | Get authentication challenge        |
| POST   | `/auth/verify`    | Verify wallet signature and get JWT |

### Escrow Management

| Method | Endpoint                      | Description              |
| ------ | ----------------------------- | ------------------------ |
| POST   | `/escrows`                    | Create new escrow        |
| GET    | `/escrows/:id`                | Get escrow by ID         |
| GET    | `/escrows/depositor/:address` | Get escrows by depositor |
| POST   | `/escrows/:id/release`        | Release escrow funds     |
| POST   | `/escrows/:id/dispute`        | Raise a dispute          |

### Gig Listings

| Method | Endpoint          | Description                                  |
| ------ | ----------------- | -------------------------------------------- |
| POST   | `/gigs`           | Create an open gig solicitation              |
| GET    | `/gigs`           | List gig solicitations with optional filters |
| GET    | `/gigs/:id`       | Get a gig listing by ID                      |
| PATCH  | `/gigs/:id`       | Update mutable listing fields or status      |
| POST   | `/gigs/:id/close` | Close a gig listing                          |
| DELETE | `/gigs/:id`       | Delete a gig listing                         |

### Webhooks

| Method | Endpoint        | Description        |
| ------ | --------------- | ------------------ |
| POST   | `/webhooks`     | Register webhook   |
| DELETE | `/webhooks/:id` | Unregister webhook |

### Monitoring

| Method | Endpoint   | Description        |
| ------ | ---------- | ------------------ |
| GET    | `/health`  | Health check       |
| GET    | `/metrics` | Prometheus metrics |

---

## 💡 Common Use Cases

### 1. Create an Escrow

```bash
curl -X POST http://localhost:3001/escrows \
  -H "Content-Type: application/json" \
  -d '{
    "depositor": "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "beneficiary": "GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY",
    "amountXLM": "100"
  }'
```

**Response**:

```json
{
  "id": "esc-1234567890",
  "depositor": "GXXXXX...",
  "beneficiary": "GYYYY...",
  "amountXLM": "100",
  "status": "pending",
  "createdAt": "2026-06-13T00:00:00.000Z"
}
```

### 2. Raise a Dispute

```bash
curl -X POST http://localhost:3001/escrows/esc-1234567890/dispute \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Work not delivered as specified"
  }'
```

**Response**:

```json
{
  "id": "esc-1234567890",
  "status": "disputed",
  "disputeReason": "Work not delivered as specified",
  "disputedAt": "2026-06-13T01:00:00.000Z"
}
```

**Note**: This also triggers:

- Webhook event (`dispute.raised`)
- Discord notification (if configured)

### 3. Create a Gig Listing

```bash
curl -X POST http://localhost:3001/gigs \
  -H "Content-Type: application/json" \
  -d '{
    "clientAddress": "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "title": "Build a Soroban escrow dashboard",
    "description": "Create a dashboard for tracking escrow milestones and gig delivery state.",
    "budgetXLM": "250.0000000",
    "category": "development",
    "skills": ["NestJS", "Soroban"]
  }'
```

Use `GET /gigs?status=open&skill=Soroban` to discover matching open
solicitations. Close completed or cancelled solicitations with
`POST /gigs/:id/close`.

### 4. Register a Webhook

```bash
curl -X POST http://localhost:3001/webhooks \
  -H "Content-Type: application/json" \
  -d '{
    "id": "my-webhook",
    "url": "https://example.com/webhooks/trustflow"
  }'
```

**Response**:

```json
{
  "registered": true,
  "id": "my-webhook"
}
```

---

## 📦 Webhook Events

When you register a webhook, you'll receive POST requests for these events:

### Event Types

| Event              | Description        | Payload            |
| ------------------ | ------------------ | ------------------ |
| `escrow.created`   | New escrow created | Escrow details     |
| `escrow.released`  | Funds released     | Escrow details     |
| `dispute.raised`   | Dispute initiated  | Dispute details    |
| `dispute.resolved` | Dispute resolved   | Resolution details |

### Webhook Payload Format

```json
{
  "event": "dispute.raised",
  "data": {
    "escrowId": "esc-1234567890",
    "depositor": "GXXXXX...",
    "beneficiary": "GYYYY...",
    "amountXLM": "100",
    "reason": "Work not delivered",
    "disputedAt": "2026-06-13T01:00:00.000Z"
  },
  "timestamp": "2026-06-13T01:00:00.000Z"
}
```

---

## 🔧 Response Codes

| Code | Description                           |
| ---- | ------------------------------------- |
| 200  | Success                               |
| 201  | Created                               |
| 400  | Bad Request - Invalid input           |
| 401  | Unauthorized - Invalid or missing JWT |
| 404  | Not Found - Resource doesn't exist    |
| 500  | Internal Server Error                 |
| 503  | Service Unavailable                   |

---

## 🛠️ Development

### Running the Server

```bash
cd backend
npm install
npm run dev
```

The API will be available at: `http://localhost:3001`  
Swagger UI will be at: `http://localhost:3001/api/docs`

### Environment Variables

```env
PORT=3001
JWT_SECRET=your-secret
STELLAR_NETWORK=TESTNET
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/... (optional)
```

---

## 📚 OpenAPI Specification

### Exporting OpenAPI JSON

```bash
# Get the specification
curl http://localhost:3001/api/docs-json > openapi.json
```

### Using with Other Tools

The OpenAPI specification can be used with:

- **Postman**: Import the JSON to create a collection
- **Insomnia**: Import for API testing
- **Code Generators**: Generate client SDKs
  ```bash
  # Generate TypeScript client
  npx @openapitools/openapi-generator-cli generate \
    -i http://localhost:3001/api/docs-json \
    -g typescript-axios \
    -o ./generated-client
  ```

---

## 🧪 Testing with Swagger UI

1. **Start the server**: `npm run dev`
2. **Open Swagger UI**: http://localhost:3001/api/docs
3. **Try an endpoint**:
   - Click on any endpoint (e.g., `GET /health`)
   - Click "Try it out"
   - Fill in parameters (if any)
   - Click "Execute"
   - View the response

### Testing Authentication Flow

1. **Get Challenge**:
   - Expand `GET /auth/challenge`
   - Enter your Stellar address
   - Execute
   - Copy the challenge message

2. **Sign with your wallet** (outside Swagger)

3. **Verify Signature**:
   - Expand `POST /auth/verify`
   - Enter address and signature
   - Execute
   - Copy the JWT token

4. **Authorize**:
   - Click 🔒 "Authorize" button at top
   - Paste your JWT token
   - Click "Authorize"

5. **Test Protected Endpoints**: Now you can test escrow endpoints!

---

## 🎨 Customization

### Adding New Endpoints

When adding new endpoints, include Swagger decorators:

```typescript
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

@ApiTags('YourTag')
@Controller('your-route')
export class YourController {
  @Get()
  @ApiOperation({ summary: 'Your endpoint summary' })
  @ApiResponse({ status: 200, description: 'Success response' })
  yourMethod() {
    // ...
  }
}
```

### Available Decorators

- `@ApiTags()` - Group endpoints by tag
- `@ApiOperation()` - Describe the endpoint
- `@ApiResponse()` - Document response schemas
- `@ApiParam()` - Document path parameters
- `@ApiQuery()` - Document query parameters
- `@ApiBody()` - Document request body
- `@ApiBearerAuth()` - Mark as requiring JWT

---

## 📖 Additional Resources

- [NestJS Swagger Documentation](https://docs.nestjs.com/openapi/introduction)
- [OpenAPI Specification](https://swagger.io/specification/)
- [Swagger UI Documentation](https://swagger.io/tools/swagger-ui/)

---

## 🤝 Contributing

When adding new API endpoints:

1. ✅ Add Swagger decorators to controllers
2. ✅ Document all parameters and responses
3. ✅ Test in Swagger UI
4. ✅ Update this documentation if needed

---

## 📞 Support

- **Documentation**: http://localhost:3001/api/docs
- **Issues**: https://github.com/trustflow-protocol/trustflow-backend/issues
- **Community**: Discord (link in main README)

---

_Auto-generated API documentation powered by Swagger/OpenAPI_
