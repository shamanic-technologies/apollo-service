# Project: apollo-service

Apollo.io integration service for lead search, enrichment, and validation with cost tracking via runs-service.

## Commands

- `pnpm test` — run all tests (Vitest)
- `pnpm test:unit` — run unit tests only
- `pnpm test:integration` — run integration tests only
- `pnpm test:watch` — run tests in watch mode
- `pnpm run build` — compile TypeScript + generate OpenAPI spec
- `pnpm run dev` — local dev server (tsx watch)
- `pnpm run generate:openapi` — regenerate openapi.json from Zod schemas
- `pnpm run start` — start production server
- `pnpm run db:generate` — generate Drizzle migrations
- `pnpm run db:migrate` — run Drizzle migrations
- `pnpm run db:push` — push schema directly (dev only)

## Architecture

- `src/schemas.ts` — Zod schemas + OpenAPI registry (source of truth for validation + OpenAPI)
- `src/routes/search.ts` — Search and enrichment endpoints (POST /search, GET /searches/:runId, GET /enrichments/:runId, POST /stats)
- `src/routes/validate.ts` — Batch validation endpoint (POST /validate)
- `src/routes/reference.ts` — Reference data endpoints (GET /reference/industries, GET /reference/employee-ranges)
- `src/routes/health.ts` — Health check endpoints
- `src/middleware/auth.ts` — Clerk org-id authentication middleware
- `src/lib/apollo-client.ts` — Apollo.io API client
- `src/lib/keys-client.ts` — BYOK key retrieval via key-service
- `src/lib/runs-client.ts` — Runs-service client for cost tracking
- `src/lib/reference-cache.ts` — 24h in-memory cache for reference data
- `src/lib/validators.ts` — Shared validation utilities
- `src/db/schema.ts` — Drizzle ORM database schema
- `src/db/index.ts` — Database connection setup
- `src/config.ts` — Environment config
- `tests/` — Test files (`*.test.ts`)
- `openapi.json` — Auto-generated from Zod schemas, do NOT edit manually

## Waterfall enrichment — canonical pattern

> **DISABLED 2026-05-28** — Apollo waterfall vendor email quality was unreliable.
> Direct Apollo `/people/match` only (1 credit per email). Revive checklist
> in `src/lib/waterfall.ts` header. The pattern below is preserved for that
> revive; current code paths bypass it entirely.

Apollo's waterfall (third-party email lookup vendors) is async on Apollo's side but **synchronous from the caller's perspective in this service**. Both `/match` and `/enrich` MUST follow this pattern when the immediate Apollo response has no email and `waterfall.status === "accepted"`:

1. **Authorize** `WATERFALL_MAX_CREDITS` upfront (platform key only). Cost can be up to 20 credits, not 1.
2. **Provision** a cost line `qty: WATERFALL_MAX_CREDITS, status: "provisioned"` on the enrichment run, store the cost id in `apolloPeopleEnrichments.provisionedCostId`.
3. **Insert** the enrichment row with `waterfallStatus: "pending"`, `waterfallRequestId`, `provisionedCostId`.
4. **Poll** the row synchronously (default 60s, 3s interval) until `email` is set, `waterfallStatus` becomes `completed`/`failed`, or timeout.
5. **Resolve**:
   - Email found in poll → cancel provisioned (webhook will add actual). Return person.
   - Webhook said no email → cancel provisioned. Return null person.
   - Timeout → mark `waterfallStatus: "timeout"`, run `failed`, leave provisioned cost in place (webhook reconciles when it eventually arrives — Apollo retries 5xx). Return 504.
6. **Webhook** (`POST /webhook/waterfall`) is the source of truth for actual cost: cancels the provisioned cost and adds `creditsConsumed` as actual on the original enrichment run. Idempotent on `waterfallStatus IN ('pending','timeout')`.
7. **Lazy cleanup on cache lookup**: if a cached row is `pending` and older than 24h (webhook never arrived), cancel provisioned + add `WATERFALL_MAX_CREDITS` actual + mark `expired`.

Negative cache (24h TTL) prevents duplicate Apollo calls for the same person/name+domain that just failed waterfall.

Do not ship an async/fire-and-forget variant of this — the caller (lead-service workflows) expects a single synchronous response with email present or definitively absent.
