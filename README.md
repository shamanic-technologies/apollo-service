# Apollo Service

Apollo.io integration service for lead finding and enrichment.

## Features

- Search for people via Apollo API
- Store and track enrichment data
- Integration with runs-service for cost tracking
- Reference data caching (industries, employee ranges)

## Setup

### Prerequisites

- Node.js 20+
- pnpm
- PostgreSQL database

### Environment Variables

```bash
# Copy example env file
cp .env.example .env
```

Required variables:
- `APOLLO_SERVICE_DATABASE_URL` - PostgreSQL connection string
- `KEY_SERVICE_URL` - URL for key-service (BYOK key retrieval)
- `KEY_SERVICE_API_KEY` - API key for key-service
- `RUNS_SERVICE_URL` - URL for runs-service (cost tracking)
- `RUNS_SERVICE_API_KEY` - API key for runs-service

Optional:
- `SENTRY_DSN` - Sentry error tracking
- `PORT` - Server port (default: 3004)

### Installation

```bash
pnpm install
```

### Database Setup

```bash
# Generate migrations
pnpm db:generate

# Run migrations
pnpm db:migrate

# Or push schema directly (dev only)
pnpm db:push
```

### Development

```bash
pnpm dev
```

### Production

```bash
pnpm build
pnpm start
```

## API Endpoints

### Search

- `POST /search` - Search for people via Apollo
- `GET /searches/:runId` - Get all searches for a run
- `GET /enrichments/:runId` - Get all enrichments for a run
- `POST /stats` - Get aggregated stats for multiple run IDs

### Validation

- `POST /validate` - Validate a batch of items against Apollo's expected format

**Body:**
```json
{
  "endpoint": "search" | "enrich" | "bulk-enrich",
  "items": [...]
}
```

**Response:**
```json
{
  "results": [
    {
      "index": 0,
      "valid": true,
      "endpoint": "search",
      "errors": []
    },
    {
      "index": 1,
      "valid": false,
      "endpoint": "search",
      "errors": [
        { "field": "organizationNumEmployeesRanges.0", "message": "Invalid enum value...", "value": "bad" }
      ]
    }
  ]
}
```

Validates:
- **search**: employee ranges (exact enum), industry tag IDs (live validation against Apollo API), pagination limits (page 1-500, perPage 1-100), non-empty strings
- **enrich**: requires Apollo person `id`
- **bulk-enrich**: requires `personIds` array (1-10 items)

### Reference Data

- `GET /reference/industries` - Get Apollo industries list (24h cached)
- `GET /reference/employee-ranges` - Get employee range options

### Health

- `GET /health` - Basic health check
- `GET /health/debug` - Debug endpoint with service status

## Authentication

All endpoints (except health) require `x-clerk-org-id` header for organization context.

## Testing

```bash
# Run all tests
pnpm test

# Run unit tests only
pnpm test:unit

# Run integration tests only
pnpm test:integration

# Watch mode
pnpm test:watch
```

## Docker

```bash
docker build -t apollo-service .
docker run -p 3004:3004 --env-file .env apollo-service
```

## Railway Deployment

The service includes a `railway.json` configuration for easy deployment to Railway.
