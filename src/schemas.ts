import { z } from "zod";
import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
} from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

// ─── Shared schemas ──────────────────────────────────────────────────────────

const VALID_EMPLOYEE_RANGES = [
  "1,10",
  "11,20",
  "21,50",
  "51,100",
  "101,200",
  "201,500",
  "501,1000",
  "1001,2000",
  "2001,5000",
  "5001,10000",
  "10001,",
] as const;

const ErrorResponseSchema = z
  .object({ error: z.string() })
  .openapi("ErrorResponse");

const PersonSchema = z
  .object({
    id: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    email: z.string().nullable(),
    emailStatus: z.string().nullable(),
    title: z.string(),
    linkedinUrl: z.string(),
    organizationName: z.string().optional(),
    organizationDomain: z.string().optional(),
    organizationIndustry: z.string().optional(),
    organizationSize: z.string().optional(),
  })
  .openapi("Person");

// ─── Auth header ─────────────────────────────────────────────────────────────

const clerkOrgIdHeader = registry.registerParameter(
  "ClerkOrgId",
  z.string().openapi({
    param: { name: "x-clerk-org-id", in: "header" },
    description: "Clerk organization ID",
    example: "org_abc123",
  })
);

// ─── GET /health ─────────────────────────────────────────────────────────────

const HealthResponseSchema = z
  .object({
    status: z.string(),
    service: z.string(),
  })
  .openapi("HealthResponse");

registry.registerPath({
  method: "get",
  path: "/health",
  summary: "Health check",
  responses: {
    200: {
      description: "Service is healthy",
      content: { "application/json": { schema: HealthResponseSchema } },
    },
  },
});

// ─── GET /health/debug ───────────────────────────────────────────────────────

const HealthDebugResponseSchema = z
  .object({
    keyServiceUrl: z.string(),
    dbConfigured: z.boolean(),
    dbStatus: z.string(),
    keyServiceStatus: z.string(),
  })
  .openapi("HealthDebugResponse");

registry.registerPath({
  method: "get",
  path: "/health/debug",
  summary: "Debug health check with dependency status",
  responses: {
    200: {
      description: "Debug health information",
      content: { "application/json": { schema: HealthDebugResponseSchema } },
    },
  },
});

// ─── POST /search ────────────────────────────────────────────────────────────

export const SearchRequestSchema = z
  .object({
    runId: z.string().optional(),
    appId: z.string(),
    brandId: z.string(),
    campaignId: z.string(),
    personTitles: z.array(z.string().min(1)).optional(),
    qOrganizationKeywordTags: z.array(z.string().min(1)).optional(),
    organizationLocations: z.array(z.string().min(1)).optional(),
    organizationNumEmployeesRanges: z
      .array(z.enum(VALID_EMPLOYEE_RANGES))
      .optional(),
    qOrganizationIndustryTagIds: z.array(z.string().min(1)).optional(),
    qKeywords: z.string().optional(),
    page: z.number().int().min(1).max(500).optional(),
    perPage: z.number().int().min(1).max(100).optional(),
  })
  .openapi("SearchRequest");

const PaginationSchema = z
  .object({
    page: z.number(),
    perPage: z.number(),
    totalEntries: z.number(),
    totalPages: z.number(),
  })
  .openapi("Pagination");

const SearchResponseSchema = z
  .object({
    searchId: z.string().nullable(),
    peopleCount: z.number(),
    totalEntries: z.number(),
    people: z.array(PersonSchema),
    pagination: PaginationSchema,
  })
  .openapi("SearchResponse");

registry.registerPath({
  method: "post",
  path: "/search",
  summary: "Search for people via Apollo",
  description:
    "Search Apollo's people database. If runId is provided, results are stored in DB and costs tracked via runs-service.",
  request: {
    headers: z.object({ "x-clerk-org-id": z.string() }),
    body: {
      content: { "application/json": { schema: SearchRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Search results",
      content: { "application/json": { schema: SearchResponseSchema } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ─── POST /enrich ────────────────────────────────────────────────────────────

export const EnrichRequestSchema = z
  .object({
    apolloPersonId: z.string().min(1, "apolloPersonId is required"),
    runId: z.string().optional(),
    appId: z.string(),
    brandId: z.string(),
    campaignId: z.string(),
  })
  .openapi("EnrichRequest");

const EnrichResponseSchema = z
  .object({
    enrichmentId: z.string().nullable(),
    person: PersonSchema.nullable(),
  })
  .openapi("EnrichResponse");

registry.registerPath({
  method: "post",
  path: "/enrich",
  summary: "Enrich a person via Apollo to reveal their email",
  description:
    "Enrich a single person by Apollo person ID. Uses 12-month cache. If runId is provided, stores record and tracks costs.",
  request: {
    headers: z.object({ "x-clerk-org-id": z.string() }),
    body: {
      content: { "application/json": { schema: EnrichRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Enrichment result",
      content: { "application/json": { schema: EnrichResponseSchema } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ─── GET /searches/:runId ────────────────────────────────────────────────────

const SearchRecordSchema = z
  .object({
    id: z.string().uuid(),
    orgId: z.string().uuid(),
    runId: z.string(),
    appId: z.string(),
    brandId: z.string(),
    campaignId: z.string(),
    requestParams: z.record(z.string(), z.unknown()),
    peopleCount: z.number(),
    totalEntries: z.number(),
    responseRaw: z.record(z.string(), z.unknown()),
    createdAt: z.string(),
  })
  .openapi("SearchRecord");

const SearchesResponseSchema = z
  .object({ searches: z.array(SearchRecordSchema) })
  .openapi("SearchesResponse");

registry.registerPath({
  method: "get",
  path: "/searches/{runId}",
  summary: "Get all searches for a run",
  request: {
    headers: z.object({ "x-clerk-org-id": z.string() }),
    params: z.object({ runId: z.string() }),
  },
  responses: {
    200: {
      description: "List of search records",
      content: { "application/json": { schema: SearchesResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ─── GET /enrichments/:runId ─────────────────────────────────────────────────

const EnrichmentRecordSchema = z
  .object({
    id: z.string().uuid(),
    orgId: z.string().uuid(),
    runId: z.string(),
    searchId: z.string().uuid().nullable().optional(),
    appId: z.string(),
    brandId: z.string(),
    campaignId: z.string(),
    apolloPersonId: z.string(),
    firstName: z.string().nullable().optional(),
    lastName: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    emailStatus: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    linkedinUrl: z.string().nullable().optional(),
    organizationName: z.string().nullable().optional(),
    organizationDomain: z.string().nullable().optional(),
    organizationIndustry: z.string().nullable().optional(),
    organizationSize: z.string().nullable().optional(),
    organizationRevenueUsd: z.string().nullable().optional(),
    responseRaw: z.record(z.string(), z.unknown()),
    enrichmentRunId: z.string().nullable().optional(),
    createdAt: z.string(),
  })
  .openapi("EnrichmentRecord");

const EnrichmentsResponseSchema = z
  .object({ enrichments: z.array(EnrichmentRecordSchema) })
  .openapi("EnrichmentsResponse");

registry.registerPath({
  method: "get",
  path: "/enrichments/{runId}",
  summary: "Get all enrichments for a run",
  request: {
    headers: z.object({ "x-clerk-org-id": z.string() }),
    params: z.object({ runId: z.string() }),
  },
  responses: {
    200: {
      description: "List of enrichment records",
      content: { "application/json": { schema: EnrichmentsResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ─── POST /stats ─────────────────────────────────────────────────────────────

export const StatsRequestSchema = z
  .object({
    runIds: z.array(z.string()).optional(),
    appId: z.string().optional(),
    brandId: z.string().optional(),
    campaignId: z.string().optional(),
  })
  .openapi("StatsRequest");

const StatsSchema = z
  .object({
    enrichedLeadsCount: z.number().int(),
    searchCount: z.number().int(),
    fetchedPeopleCount: z.number().int(),
    totalMatchingPeople: z.number().int(),
  })
  .openapi("Stats");

const StatsResponseSchema = z
  .object({ stats: StatsSchema })
  .openapi("StatsResponse");

registry.registerPath({
  method: "post",
  path: "/stats",
  summary: "Get aggregated stats",
  description:
    "Returns aggregated search and enrichment stats. All body filters are optional; orgId is always applied from auth.",
  request: {
    headers: z.object({ "x-clerk-org-id": z.string() }),
    body: {
      content: { "application/json": { schema: StatsRequestSchema } },
      required: false,
    },
  },
  responses: {
    200: {
      description: "Aggregated stats",
      content: { "application/json": { schema: StatsResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ─── GET /reference/industries ───────────────────────────────────────────────

const IndustrySchema = z
  .object({ name: z.string() })
  .openapi("Industry");

const IndustriesResponseSchema = z
  .object({ industries: z.array(IndustrySchema) })
  .openapi("IndustriesResponse");

registry.registerPath({
  method: "get",
  path: "/reference/industries",
  summary: "Get Apollo industries list",
  request: {
    headers: z.object({ "x-clerk-org-id": z.string() }),
  },
  responses: {
    200: {
      description: "List of industries",
      content: { "application/json": { schema: IndustriesResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ─── GET /reference/employee-ranges ──────────────────────────────────────────

const EmployeeRangeSchema = z
  .object({
    label: z.string(),
    value: z.string(),
  })
  .openapi("EmployeeRange");

const EmployeeRangesResponseSchema = z
  .object({ ranges: z.array(EmployeeRangeSchema) })
  .openapi("EmployeeRangesResponse");

registry.registerPath({
  method: "get",
  path: "/reference/employee-ranges",
  summary: "Get employee range options",
  request: {
    headers: z.object({ "x-clerk-org-id": z.string() }),
  },
  responses: {
    200: {
      description: "List of employee ranges",
      content: {
        "application/json": { schema: EmployeeRangesResponseSchema },
      },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ─── POST /validate ──────────────────────────────────────────────────────────

export const ValidateRequestSchema = z
  .object({
    endpoint: z.enum(["search", "enrich", "bulk-enrich"]),
    items: z.array(z.unknown()).min(1),
  })
  .openapi("ValidateRequest");

const ValidationErrorSchema = z
  .object({
    field: z.string(),
    message: z.string(),
    value: z.unknown(),
  })
  .openapi("ValidationError");

const ValidationResultSchema = z
  .object({
    index: z.number(),
    valid: z.boolean(),
    endpoint: z.enum(["search", "enrich", "bulk-enrich"]),
    errors: z.array(ValidationErrorSchema),
  })
  .openapi("ValidationResult");

const ValidateResponseSchema = z
  .object({ results: z.array(ValidationResultSchema) })
  .openapi("ValidateResponse");

registry.registerPath({
  method: "post",
  path: "/validate",
  summary: "Validate a batch of items against Apollo schemas",
  description:
    "Validates items against the specified endpoint schema (search, enrich, or bulk-enrich).",
  request: {
    headers: z.object({ "x-clerk-org-id": z.string() }),
    body: {
      content: { "application/json": { schema: ValidateRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Validation results",
      content: { "application/json": { schema: ValidateResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});
