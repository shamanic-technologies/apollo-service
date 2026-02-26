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

const VALID_SENIORITIES = [
  "entry",
  "senior",
  "manager",
  "director",
  "vp",
  "c_suite",
  "owner",
  "founder",
  "partner",
] as const;

const VALID_EMAIL_STATUSES = [
  "verified",
  "guessed",
  "unavailable",
  "bounced",
  "pending_manual_fulfillment",
] as const;

const ErrorResponseSchema = z
  .object({ error: z.string() })
  .openapi("ErrorResponse");

const EmploymentHistorySchema = z.object({
  title: z.string().optional(),
  organizationName: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  description: z.string().optional(),
  current: z.boolean().optional(),
});

const FundingEventSchema = z.object({
  id: z.string().optional(),
  date: z.string().optional(),
  type: z.string().optional(),
  investors: z.string().optional(),
  amount: z.number().optional(),
  currency: z.string().optional(),
});

const TechnologySchema = z.object({
  uid: z.string().optional(),
  name: z.string().optional(),
  category: z.string().optional(),
});

const PersonSchema = z
  .object({
    id: z.string(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    email: z.string().nullable(),
    emailStatus: z.string().nullable(),
    title: z.string().nullable(),
    linkedinUrl: z.string().nullable(),
    // Person profile
    photoUrl: z.string().nullable().optional(),
    headline: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    seniority: z.string().nullable().optional(),
    departments: z.array(z.string()).nullable().optional(),
    subdepartments: z.array(z.string()).nullable().optional(),
    functions: z.array(z.string()).nullable().optional(),
    twitterUrl: z.string().nullable().optional(),
    githubUrl: z.string().nullable().optional(),
    facebookUrl: z.string().nullable().optional(),
    employmentHistory: z.array(EmploymentHistorySchema).nullable().optional(),
    // Organization (flat fields — Apollo's nested organization object is flattened to camelCase)
    organizationName: z.string().nullable().optional(),
    organizationDomain: z.string().nullable().optional(),
    organizationIndustry: z.string().nullable().optional(),
    organizationSize: z.string().nullable().optional(),
    organizationRevenueUsd: z.string().nullable().optional(),
    organizationWebsiteUrl: z.string().nullable().optional(),
    organizationLogoUrl: z.string().nullable().optional(),
    organizationShortDescription: z.string().nullable().optional(),
    organizationSeoDescription: z.string().nullable().optional(),
    organizationLinkedinUrl: z.string().nullable().optional(),
    organizationTwitterUrl: z.string().nullable().optional(),
    organizationFacebookUrl: z.string().nullable().optional(),
    organizationBlogUrl: z.string().nullable().optional(),
    organizationCrunchbaseUrl: z.string().nullable().optional(),
    organizationAngellistUrl: z.string().nullable().optional(),
    organizationFoundedYear: z.number().nullable().optional(),
    organizationPrimaryPhone: z.string().nullable().optional(),
    organizationPubliclyTradedSymbol: z.string().nullable().optional(),
    organizationPubliclyTradedExchange: z.string().nullable().optional(),
    organizationAnnualRevenuePrinted: z.string().nullable().optional(),
    organizationTotalFunding: z.string().nullable().optional(),
    organizationTotalFundingPrinted: z.string().nullable().optional(),
    organizationLatestFundingRoundDate: z.string().nullable().optional(),
    organizationLatestFundingStage: z.string().nullable().optional(),
    organizationFundingEvents: z.array(FundingEventSchema).nullable().optional(),
    organizationCity: z.string().nullable().optional(),
    organizationState: z.string().nullable().optional(),
    organizationCountry: z.string().nullable().optional(),
    organizationStreetAddress: z.string().nullable().optional(),
    organizationPostalCode: z.string().nullable().optional(),
    organizationTechnologyNames: z.array(z.string()).nullable().optional(),
    organizationCurrentTechnologies: z.array(TechnologySchema).nullable().optional(),
    organizationKeywords: z.array(z.string()).nullable().optional(),
    organizationIndustries: z.array(z.string()).nullable().optional(),
    organizationSecondaryIndustries: z.array(z.string()).nullable().optional(),
    organizationNumSuborganizations: z.number().nullable().optional(),
    organizationRetailLocationCount: z.number().nullable().optional(),
    organizationAlexaRanking: z.number().nullable().optional(),
  })
  .openapi("Person");

// ─── Auth header ─────────────────────────────────────────────────────────────

const orgIdHeader = registry.registerParameter(
  "OrgId",
  z.string().openapi({
    param: { name: "x-org-id", in: "header" },
    description: "Organization ID",
    example: "550e8400-e29b-41d4-a716-446655440000",
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
    runId: z.string().openapi({ description: "Runs-service parent run ID. Required — results are stored in DB and costs tracked via runs-service.", example: "run-abc-123" }),
    appId: z.string(),
    brandId: z.string(),
    campaignId: z.string(),
    workflowName: z.string().optional().openapi({ description: "Workflow name for run tracking in runs-service.", example: "fetch-lead" }),
    personTitles: z.array(z.string().min(1)).optional().openapi({
      description: "Filter by job titles. Combined with other filters using AND.",
      example: ["CEO", "CTO", "VP Engineering"],
    }),
    qOrganizationKeywordTags: z.array(z.string().min(1)).optional().openapi({
      description: "Filter by organization keyword tags. Combined with other filters using AND.",
      example: ["SaaS", "fintech"],
    }),
    organizationLocations: z.array(z.string().min(1)).optional().openapi({
      description: "Filter by organization HQ location. Combined with other filters using AND.",
      example: ["United States", "California, US"],
    }),
    organizationNumEmployeesRanges: z
      .array(z.enum(VALID_EMPLOYEE_RANGES))
      .optional()
      .openapi({
        description: "Filter by employee count ranges. Combined with other filters using AND.",
        example: ["11,20", "21,50", "51,100"],
      }),
    qOrganizationIndustryTagIds: z.array(z.string().min(1)).optional().openapi({
      description: "Filter by industry names (use GET /reference/industries for valid values). Combined with other filters using AND.",
      example: ["Information Technology and Services", "Computer Software"],
    }),
    qKeywords: z.string().optional().openapi({
      description: "Free-text keyword search across person and organization fields. Combined with other filters using AND. Keep broad to avoid empty results.",
      example: "machine learning",
    }),
    personLocations: z.array(z.string().min(1)).optional().openapi({
      description: "Filter by person's location (city, state, country). Different from organizationLocations which filters by company HQ. Combined with other filters using AND.",
      example: ["San Francisco, California, US", "New York, US"],
    }),
    personSeniorities: z.array(z.enum(VALID_SENIORITIES)).optional().openapi({
      description: "Filter by seniority level. Valid values: entry, senior, manager, director, vp, c_suite, owner, founder, partner. Combined with other filters using AND.",
      example: ["director", "vp", "c_suite"],
    }),
    contactEmailStatus: z.array(z.enum(VALID_EMAIL_STATUSES)).optional().openapi({
      description: "Filter by email verification status. Valid values: verified, guessed, unavailable, bounced, pending_manual_fulfillment. Combined with other filters using AND.",
      example: ["verified"],
    }),
    qOrganizationDomains: z.array(z.string().min(1)).optional().openapi({
      description: "Filter by specific company domains. Combined with other filters using AND.",
      example: ["google.com", "meta.com"],
    }),
    currentlyUsingAnyOfTechnologyUids: z.array(z.string().min(1)).optional().openapi({
      description: "Filter by technology stack (Apollo technology UIDs). Combined with other filters using AND.",
      example: ["salesforce", "hubspot"],
    }),
    revenueRange: z.array(z.string().min(1)).optional().openapi({
      description: "Filter by annual revenue ranges (comma-separated min,max format, similar to employee ranges). Combined with other filters using AND.",
      example: ["1000000,10000000", "10000000,50000000"],
    }),
    organizationIds: z.array(z.string().min(1)).optional().openapi({
      description: "Filter by specific Apollo organization IDs. Combined with other filters using AND.",
      example: ["5f5e100a01d6b1000169c754"],
    }),
    page: z.number().int().min(1).max(500).optional(),
    perPage: z.number().int().min(1).max(100).optional(),
  })
  .openapi("SearchRequest", {
    description: "All search filters are combined using AND. Using too many filters simultaneously may return 0 results — start broad and narrow down.",
  });

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
    headers: z.object({ "x-org-id": z.string() }),
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

// ─── POST /search/next ──────────────────────────────────────────────────────

export const SearchFiltersSchema = z
  .object({
    personTitles: z.array(z.string().min(1)).optional().openapi({
      description: "Filter by job titles.",
      example: ["CEO", "CTO", "VP Engineering"],
    }),
    qOrganizationKeywordTags: z.array(z.string().min(1)).optional().openapi({
      description: "Filter by organization keyword tags.",
      example: ["SaaS", "fintech"],
    }),
    organizationLocations: z.array(z.string().min(1)).optional().openapi({
      description: "Filter by organization HQ location.",
      example: ["United States", "California, US"],
    }),
    organizationNumEmployeesRanges: z.array(z.enum(VALID_EMPLOYEE_RANGES)).optional().openapi({
      description: "Filter by employee count ranges.",
      example: ["11,20", "21,50", "51,100"],
    }),
    qOrganizationIndustryTagIds: z.array(z.string().min(1)).optional().openapi({
      description: "Filter by industry names (use GET /reference/industries for valid values).",
      example: ["Information Technology and Services", "Computer Software"],
    }),
    qKeywords: z.string().optional().openapi({
      description: "Free-text keyword search across person and organization fields.",
      example: "machine learning",
    }),
    personLocations: z.array(z.string().min(1)).optional().openapi({
      description: "Filter by person's location (city, state, country). Different from organizationLocations which filters by company HQ.",
      example: ["San Francisco, California, US", "New York, US"],
    }),
    personSeniorities: z.array(z.enum(VALID_SENIORITIES)).optional().openapi({
      description: "Filter by seniority level. Valid values: entry, senior, manager, director, vp, c_suite, owner, founder, partner.",
      example: ["director", "vp", "c_suite"],
    }),
    contactEmailStatus: z.array(z.enum(VALID_EMAIL_STATUSES)).optional().openapi({
      description: "Filter by email verification status. Valid values: verified, guessed, unavailable, bounced, pending_manual_fulfillment.",
      example: ["verified"],
    }),
    qOrganizationDomains: z.array(z.string().min(1)).optional().openapi({
      description: "Filter by specific company domains.",
      example: ["google.com", "meta.com"],
    }),
    currentlyUsingAnyOfTechnologyUids: z.array(z.string().min(1)).optional().openapi({
      description: "Filter by technology stack (Apollo technology UIDs).",
      example: ["salesforce", "hubspot"],
    }),
    revenueRange: z.array(z.string().min(1)).optional().openapi({
      description: "Filter by annual revenue ranges (comma-separated min,max format).",
      example: ["1000000,10000000", "10000000,50000000"],
    }),
    organizationIds: z.array(z.string().min(1)).optional().openapi({
      description: "Filter by specific Apollo organization IDs.",
      example: ["5f5e100a01d6b1000169c754"],
    }),
  })
  .openapi("SearchFilters", {
    description: "Apollo search filters. All filters are combined using AND. Start broad and narrow down to avoid empty results.",
  });

export const SearchNextRequestSchema = z
  .object({
    campaignId: z.string().openapi({
      description: "Campaign ID — used as the pagination cursor key. One cursor per (orgId, campaignId).",
      example: "campaign-abc-123",
    }),
    brandId: z.string().openapi({ description: "Brand ID.", example: "brand-1" }),
    appId: z.string().openapi({ description: "App ID.", example: "my-app" }),
    searchParams: SearchFiltersSchema.optional().openapi({
      description: "Search filters. On first call, provide filters to create a cursor at page 1. On subsequent calls, omit to continue from the last page. If provided and different from the stored filters, the cursor resets to page 1.",
    }),
    runId: z.string().openapi({
      description: "Runs-service parent run ID. Required — a search audit record is stored and 1 apollo-search-credit is tracked.",
      example: "run-abc-123",
    }),
    workflowName: z.string().optional().openapi({ description: "Workflow name for run tracking in runs-service.", example: "fetch-lead" }),
  })
  .openapi("SearchNextRequest", {
    description: "Request body for server-managed search pagination. The cursor is keyed by (orgId, campaignId).",
  });

const SearchNextResponseSchema = z
  .object({
    people: z.array(PersonSchema).openapi({ description: "People returned for this page. Empty array when done=true." }),
    done: z.boolean().openapi({ description: "True when all pages have been exhausted. No more results to fetch." }),
    totalEntries: z.number().openapi({ description: "Total number of people matching the search filters across all pages." }),
  })
  .openapi("SearchNextResponse", {
    description: "One page of search results with pagination state.",
  });

registry.registerPath({
  method: "post",
  path: "/search/next",
  summary: "Get next page of search results for a campaign",
  description:
    "Server-managed pagination. First call with searchParams creates a cursor at page 1. Subsequent calls (with or without searchParams) return the next page. Each call returns one page of 25 people and advances the cursor. When done=true, all pages are exhausted. If searchParams differ from the stored cursor, pagination resets to page 1.",
  request: {
    headers: z.object({ "x-org-id": z.string() }),
    body: {
      content: { "application/json": { schema: SearchNextRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Next batch of people",
      content: { "application/json": { schema: SearchNextResponseSchema } },
    },
    400: {
      description: "No cursor found (call with searchParams first) or validation error",
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
    runId: z.string().openapi({ description: "Runs-service parent run ID. Required — enrichment record is stored and 1 apollo-enrichment-credit is tracked.", example: "run-abc-123" }),
    appId: z.string(),
    brandId: z.string(),
    campaignId: z.string(),
    workflowName: z.string().optional().openapi({ description: "Workflow name for run tracking in runs-service.", example: "fetch-lead" }),
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
    headers: z.object({ "x-org-id": z.string() }),
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

// ─── POST /match ────────────────────────────────────────────────────────────

export const MatchRequestSchema = z
  .object({
    firstName: z.string().min(1, "firstName is required"),
    lastName: z.string().min(1, "lastName is required"),
    organizationDomain: z.string().min(1, "organizationDomain is required"),
    runId: z.string().openapi({
      description: "Runs-service parent run ID. Required — match record is stored and costs tracked.",
      example: "run-abc-123",
    }),
    appId: z.string(),
    brandId: z.string(),
    campaignId: z.string(),
    workflowName: z.string().optional().openapi({
      description: "Workflow name for run tracking in runs-service.",
      example: "fetch-lead",
    }),
  })
  .openapi("MatchRequest");

const MatchResponseSchema = z
  .object({
    enrichmentId: z.string().nullable(),
    person: PersonSchema.nullable(),
    cached: z.boolean().openapi({
      description: "True if the result was served from cache (no Apollo API call).",
    }),
  })
  .openapi("MatchResponse");

registry.registerPath({
  method: "post",
  path: "/match",
  summary: "Match a person by name and organization domain via Apollo",
  description:
    "Match a single person by firstName + lastName + organizationDomain. Uses 12-month cache. Costs tracked as apollo-person-match-credit (only charged when email is found).",
  request: {
    headers: z.object({ "x-org-id": z.string() }),
    body: {
      content: { "application/json": { schema: MatchRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Match result",
      content: { "application/json": { schema: MatchResponseSchema } },
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

// ─── POST /match/bulk ───────────────────────────────────────────────────────

const MatchBulkItemSchema = z
  .object({
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    organizationDomain: z.string().min(1),
  })
  .openapi("MatchBulkItem");

export const MatchBulkRequestSchema = z
  .object({
    items: z
      .array(MatchBulkItemSchema)
      .min(1, "At least one item required")
      .max(10, "Maximum 10 items per request"),
    runId: z.string().openapi({
      description: "Runs-service parent run ID. A single run covers the entire batch.",
      example: "run-abc-123",
    }),
    appId: z.string(),
    brandId: z.string(),
    campaignId: z.string(),
    workflowName: z.string().optional().openapi({
      description: "Workflow name for run tracking in runs-service.",
      example: "fetch-lead",
    }),
  })
  .openapi("MatchBulkRequest");

const MatchBulkResultSchema = z
  .object({
    enrichmentId: z.string().nullable(),
    person: PersonSchema.nullable(),
    cached: z.boolean(),
  })
  .openapi("MatchBulkResult");

const MatchBulkResponseSchema = z
  .object({
    results: z.array(MatchBulkResultSchema).openapi({
      description: "Results in the same order as the input items array.",
    }),
  })
  .openapi("MatchBulkResponse");

registry.registerPath({
  method: "post",
  path: "/match/bulk",
  summary: "Bulk match people by name and organization domain via Apollo",
  description:
    "Match up to 10 people by firstName + lastName + organizationDomain. Each item is cached independently. A single run covers the whole batch; costs tracked per item (apollo-person-match-credit, only when email found).",
  request: {
    headers: z.object({ "x-org-id": z.string() }),
    body: {
      content: { "application/json": { schema: MatchBulkRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Bulk match results",
      content: { "application/json": { schema: MatchBulkResponseSchema } },
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
    headers: z.object({ "x-org-id": z.string() }),
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
    // Person fields
    firstName: z.string().nullable().optional(),
    lastName: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    emailStatus: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    linkedinUrl: z.string().nullable().optional(),
    photoUrl: z.string().nullable().optional(),
    headline: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    seniority: z.string().nullable().optional(),
    departments: z.array(z.string()).nullable().optional(),
    subdepartments: z.array(z.string()).nullable().optional(),
    functions: z.array(z.string()).nullable().optional(),
    twitterUrl: z.string().nullable().optional(),
    githubUrl: z.string().nullable().optional(),
    facebookUrl: z.string().nullable().optional(),
    employmentHistory: z.array(EmploymentHistorySchema).nullable().optional(),
    // Organization fields
    organizationName: z.string().nullable().optional(),
    organizationDomain: z.string().nullable().optional(),
    organizationIndustry: z.string().nullable().optional(),
    organizationSize: z.string().nullable().optional(),
    organizationRevenueUsd: z.string().nullable().optional(),
    organizationWebsiteUrl: z.string().nullable().optional(),
    organizationLogoUrl: z.string().nullable().optional(),
    organizationShortDescription: z.string().nullable().optional(),
    organizationSeoDescription: z.string().nullable().optional(),
    organizationLinkedinUrl: z.string().nullable().optional(),
    organizationTwitterUrl: z.string().nullable().optional(),
    organizationFacebookUrl: z.string().nullable().optional(),
    organizationBlogUrl: z.string().nullable().optional(),
    organizationCrunchbaseUrl: z.string().nullable().optional(),
    organizationAngellistUrl: z.string().nullable().optional(),
    organizationFoundedYear: z.number().nullable().optional(),
    organizationPrimaryPhone: z.string().nullable().optional(),
    organizationPubliclyTradedSymbol: z.string().nullable().optional(),
    organizationPubliclyTradedExchange: z.string().nullable().optional(),
    organizationAnnualRevenuePrinted: z.string().nullable().optional(),
    organizationTotalFunding: z.string().nullable().optional(),
    organizationTotalFundingPrinted: z.string().nullable().optional(),
    organizationLatestFundingRoundDate: z.string().nullable().optional(),
    organizationLatestFundingStage: z.string().nullable().optional(),
    organizationFundingEvents: z.array(FundingEventSchema).nullable().optional(),
    organizationCity: z.string().nullable().optional(),
    organizationState: z.string().nullable().optional(),
    organizationCountry: z.string().nullable().optional(),
    organizationStreetAddress: z.string().nullable().optional(),
    organizationPostalCode: z.string().nullable().optional(),
    organizationTechnologyNames: z.array(z.string()).nullable().optional(),
    organizationCurrentTechnologies: z.array(TechnologySchema).nullable().optional(),
    organizationKeywords: z.array(z.string()).nullable().optional(),
    organizationIndustries: z.array(z.string()).nullable().optional(),
    organizationSecondaryIndustries: z.array(z.string()).nullable().optional(),
    organizationNumSuborganizations: z.number().nullable().optional(),
    organizationRetailLocationCount: z.number().nullable().optional(),
    organizationAlexaRanking: z.number().nullable().optional(),
    // Meta
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
    headers: z.object({ "x-org-id": z.string() }),
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
    headers: z.object({ "x-org-id": z.string() }),
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
    headers: z.object({ "x-org-id": z.string() }),
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
    headers: z.object({ "x-org-id": z.string() }),
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

// ─── POST /search/params ────────────────────────────────────────────────────

export const SearchParamsRequestSchema = z
  .object({
    context: z.string().min(1).openapi({
      description:
        "Unstructured context about the company — website content, target audience description, ICP notes, or any combination. The LLM extracts what it needs.",
      example:
        "We are a B2B SaaS company selling developer tools. Target audience: engineering leaders at mid-size tech companies in the US.",
    }),
    keySource: z.enum(["byok", "app"]).openapi({
      description:
        'Where to fetch API keys (Apollo + Anthropic). "byok" = user\'s own keys from key-service, "app" = platform app keys.',
      example: "app",
    }),
    runId: z.string().openapi({
      description: "Runs-service parent run ID for cost tracking.",
      example: "run-abc-123",
    }),
    appId: z.string().openapi({ example: "my-app" }),
    brandId: z.string().openapi({ example: "brand-1" }),
    campaignId: z.string().openapi({ example: "campaign-1" }),
    workflowName: z.string().optional().openapi({ description: "Workflow name for run tracking in runs-service.", example: "fetch-lead" }),
  })
  .openapi("SearchParamsRequest");

const SearchParamsAttemptSchema = z
  .object({
    searchParams: SearchFiltersSchema,
    totalResults: z.number(),
  })
  .openapi("SearchParamsAttempt");

const SearchParamsResponseSchema = z
  .object({
    searchParams: SearchFiltersSchema.openapi({
      description: "Validated Apollo search filters that returned results.",
    }),
    totalResults: z.number().openapi({
      description: "Apollo total_entries for the final search params.",
    }),
    attempts: z.number().openapi({
      description: "Number of LLM iterations (1 = first try worked).",
    }),
    attemptHistory: z.array(SearchParamsAttemptSchema).openapi({
      description: "Full history of all attempts for debugging.",
    }),
  })
  .openapi("SearchParamsResponse");

registry.registerPath({
  method: "post",
  path: "/search/params",
  summary: "Generate Apollo search parameters from context using LLM",
  description:
    "Takes unstructured context (website content, target audience, etc.) and uses Claude to generate Apollo search filters. Validates against Apollo — if 0 results, retries with broadened filters (max 10 attempts). Returns validated search params guaranteed to produce results, or the best-effort params after 10 attempts.",
  request: {
    headers: z.object({ "x-org-id": z.string() }),
    body: {
      content: { "application/json": { schema: SearchParamsRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Generated and validated search parameters",
      content: { "application/json": { schema: SearchParamsResponseSchema } },
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
    headers: z.object({ "x-org-id": z.string() }),
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
