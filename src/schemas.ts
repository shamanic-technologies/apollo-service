import { z } from "zod";
import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
} from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

// ─── Email status enum (response values from Apollo) ────────────────────────

export const EMAIL_STATUSES = [
  "verified",
  "unavailable",
  "extrapolated",
  "unverified",
  "unknown",
  "catch_all",
  "update_required",
  "user_managed",
] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];
const EmailStatusSchema = z.enum(EMAIL_STATUSES).nullable().openapi({
  description: [
    "Email verification status returned by Apollo. Null when no email was found.",
    "",
    "| Value | Description |",
    "| --- | --- |",
    "| `verified` | Email confirmed deliverable via SMTP check |",
    "| `unavailable` | Apollo could not find an email for this person |",
    "| `extrapolated` | Email pattern-matched from known company format (Apollo UI: \"Guessed\") |",
    "| `unverified` | Email found but not yet verified |",
    "| `unknown` | Verification attempted but result is inconclusive |",
    "| `catch_all` | Domain accepts all addresses — deliverability uncertain |",
    "| `update_required` | Previously verified email that needs re-verification |",
    "| `user_managed` | Email manually entered or overridden by an Apollo user |",
    "| `null` | No email data available |",
  ].join("\n"),
});

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
  "unverified",
  "likely to engage",
  "unavailable",
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

const PhoneNumberSchema = z.object({
  rawNumber: z.string().optional(),
  sanitizedNumber: z.string().optional(),
  type: z.string().optional(),
  position: z.number().optional(),
  status: z.string().optional(),
  dncStatus: z.string().optional(),
  dncOtherInfo: z.string().optional(),
  dialerFlags: z.record(z.string(), z.unknown()).optional(),
});

export const PersonSchema = z
  .object({
    id: z.string(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    name: z.string().nullable().optional(),
    email: z.string().nullable(),
    emailStatus: EmailStatusSchema,
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
    // Contact details
    personalEmails: z.array(z.string()).nullable().optional(),
    mobilePhone: z.string().nullable().optional(),
    phoneNumbers: z.array(PhoneNumberSchema).nullable().optional(),
    employmentHistory: z.array(EmploymentHistorySchema).nullable().optional(),
    // Organization (flat fields — Apollo's nested organization object is flattened to camelCase)
    organizationId: z.string().nullable().optional(),
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
    organizationRawAddress: z.string().nullable().optional(),
    organizationTechnologyNames: z.array(z.string()).nullable().optional(),
    organizationCurrentTechnologies: z.array(TechnologySchema).nullable().optional(),
    organizationKeywords: z.array(z.string()).nullable().optional(),
    organizationIndustries: z.array(z.string()).nullable().optional(),
    organizationSecondaryIndustries: z.array(z.string()).nullable().optional(),
    organizationNumSuborganizations: z.number().nullable().optional(),
    organizationRetailLocationCount: z.number().nullable().optional(),
    organizationAlexaRanking: z.number().nullable().optional(),
    raw: z.record(z.string(), z.unknown()).nullable().optional().openapi({
      description:
        "Full Apollo person payload (snake_case, verbatim). Includes any field returned by Apollo not yet mapped to a typed property. Use this for fields not exposed as typed columns.",
    }),
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

// ─── Header schemas for OpenAPI ─────────────────────────────────────────────

const basicHeaders = z.object({ "x-org-id": z.string(), "x-user-id": z.string() });

const runContextHeaders = z.object({
  "x-org-id": z.string(),
  "x-user-id": z.string(),
  "x-run-id": z.string().openapi({ description: "Caller's run ID — used as parentRunId when creating child runs", example: "run-abc-123" }),
  "x-brand-id": z.string().openapi({ description: "Brand ID(s) — single UUID or comma-separated list", example: "brand-1,brand-2" }),
  "x-campaign-id": z.string().openapi({ description: "Campaign ID", example: "campaign-1" }),
  "x-feature-slug": z.string().optional().openapi({ description: "Feature slug for tracking", example: "lead-gen" }),
  "x-workflow-slug": z.string().optional().openapi({ description: "Workflow slug for run tracking", example: "fetch-lead" }),
});

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

// ─── Shared filter schema (used by /search/next + /search/dry-run) ──────────

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
      description: "Filter by email verification status. Valid values: verified, unverified, likely to engage, unavailable.",
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

// ─── POST /search/dry-run ───────────────────────────────────────────────────

export const SearchDryRunRequestSchema = SearchFiltersSchema.openapi("SearchDryRunRequest", {
  description:
    "Apollo search filters. Used to count matching people without consuming credits, creating runs, or writing to the DB.",
});

const SearchDryRunResponseSchema = z
  .object({
    totalEntries: z.number().openapi({
      description: "Total number of people matching the filters across all pages.",
    }),
    validationErrors: z.array(z.string()).openapi({
      description:
        "Empty array on a successful 200. On a 400, lists the schema validation errors that prevented the call.",
    }),
  })
  .openapi("SearchDryRunResponse");

registry.registerPath({
  method: "post",
  path: "/search/dry-run",
  summary: "Cheap filter test — count matches without consuming credits or writing to the DB",
  description:
    "Validates the supplied filters and calls Apollo with per_page=1 to retrieve totalEntries. Performs zero database writes, zero cost tracking, and never creates a run in runs-service. Designed to be hammered by an LLM in lead-service that is exploring filter variants. Schema-invalid bodies return 400 with validationErrors populated.",
  request: {
    headers: basicHeaders,
    body: {
      content: { "application/json": { schema: SearchDryRunRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Match count for the supplied filters",
      content: { "application/json": { schema: SearchDryRunResponseSchema } },
    },
    400: {
      description: "Schema validation failed — see validationErrors",
      content: { "application/json": { schema: SearchDryRunResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ─── POST /search/next ──────────────────────────────────────────────────────

export const SearchNextRequestSchema = z
  .object({
    searchParams: SearchFiltersSchema.optional().openapi({
      description: "Search filters. On first call, provide filters to create a cursor at page 1. On subsequent calls, omit to continue from the last page. If provided and different from the stored filters, the cursor resets to page 1.",
    }),
  })
  .openapi("SearchNextRequest", {
    description: "Request body for server-managed search pagination. The cursor is keyed by (orgId, x-campaign-id header).",
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
    "Server-managed pagination. First call with searchParams creates a cursor at page 1. Subsequent calls (with or without searchParams) return the next page. Each call returns one page of 100 people and advances the cursor. done=true is set only when the next page is past Apollo's totalPages — transient mid-stream empty pages do not exhaust the cursor. If searchParams differ from the stored cursor, pagination resets to page 1.",
  request: {
    headers: runContextHeaders,
    body: {
      content: { "application/json": { schema: SearchNextRequestSchema } },
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
    headers: runContextHeaders,
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
    "Match a single person by firstName + lastName + organizationDomain. Uses 12-month cache. Costs tracked as apollo-credit (only charged when email is found).",
  request: {
    headers: runContextHeaders,
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


// ─── GET /searches/:runId ────────────────────────────────────────────────────

const SearchRecordSchema = z
  .object({
    id: z.string().uuid(),
    orgId: z.string().uuid(),
    runId: z.string(),
    brandIds: z.array(z.string()).openapi({ description: "Brand IDs associated with this search", example: ["brand-1", "brand-2"] }),
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
    headers: basicHeaders,
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
    brandIds: z.array(z.string()).openapi({ description: "Brand IDs associated with this enrichment", example: ["brand-1", "brand-2"] }),
    campaignId: z.string(),
    apolloPersonId: z.string(),
    // Person fields
    firstName: z.string().nullable().optional(),
    lastName: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    emailStatus: EmailStatusSchema.optional(),
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
    personalEmails: z.array(z.string()).nullable().optional(),
    mobilePhone: z.string().nullable().optional(),
    phoneNumbers: z.array(PhoneNumberSchema).nullable().optional(),
    employmentHistory: z.array(EmploymentHistorySchema).nullable().optional(),
    // Organization fields
    organizationId: z.string().nullable().optional(),
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
    organizationRawAddress: z.string().nullable().optional(),
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
    headers: basicHeaders,
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

const StatsGroupByEnum = z
  .enum([
    "workflowSlug",
    "featureSlug",
    "workflowDynastySlug",
    "featureDynastySlug",
  ])
  .openapi("StatsGroupBy");

export const StatsRequestSchema = z
  .object({
    runIds: z.array(z.string()).optional(),
    brandId: z.string().optional(),
    campaignId: z.string().optional(),
    workflowSlug: z.string().optional().openapi({ description: "Filter by exact workflow slug" }),
    featureSlug: z.string().optional().openapi({ description: "Filter by exact feature slug" }),
    workflowDynastySlug: z.string().optional().openapi({ description: "Filter by workflow dynasty slug (resolved to all versioned slugs)" }),
    featureDynastySlug: z.string().optional().openapi({ description: "Filter by feature dynasty slug (resolved to all versioned slugs)" }),
    groupBy: StatsGroupByEnum.optional().openapi({ description: "Group results by slug or dynasty slug" }),
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

const GroupedStatsEntrySchema = z
  .object({
    key: z.string().openapi({ description: "The slug or dynasty slug value for this group" }),
    enrichedLeadsCount: z.number().int(),
    searchCount: z.number().int(),
    fetchedPeopleCount: z.number().int(),
    totalMatchingPeople: z.number().int(),
  })
  .openapi("GroupedStatsEntry");

const StatsResponseSchema = z
  .object({
    stats: StatsSchema.optional(),
    grouped: z.array(GroupedStatsEntrySchema).optional(),
  })
  .openapi("StatsResponse");

registry.registerPath({
  method: "post",
  path: "/stats",
  summary: "Get aggregated stats",
  description:
    "Returns aggregated search and enrichment stats. All body filters are optional; orgId is always applied from auth.",
  request: {
    headers: basicHeaders,
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
    headers: basicHeaders,
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
    headers: basicHeaders,
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

// ─── POST /internal/transfer-brand ───────────────────────────────────────

export const TransferBrandRequestSchema = z
  .object({
    sourceBrandId: z.string().uuid(),
    sourceOrgId: z.string().uuid(),
    targetOrgId: z.string().uuid(),
    targetBrandId: z.string().uuid().optional(),
  })
  .openapi("TransferBrandRequest");

const TransferBrandTableResultSchema = z
  .object({
    tableName: z.string(),
    count: z.number().int(),
  })
  .openapi("TransferBrandTableResult");

const TransferBrandResponseSchema = z
  .object({
    updatedTables: z.array(TransferBrandTableResultSchema),
  })
  .openapi("TransferBrandResponse");

registry.registerPath({
  method: "post",
  path: "/internal/transfer-brand",
  summary: "Transfer solo-brand rows from one org to another",
  description:
    "Re-assigns all rows referencing exactly this brandId (solo-brand only) from sourceOrgId to targetOrgId. Rows with multiple brand IDs are skipped. Idempotent — running twice is a no-op.",
  request: {
    body: {
      content: { "application/json": { schema: TransferBrandRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Transfer results per table",
      content: { "application/json": { schema: TransferBrandResponseSchema } },
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
    headers: basicHeaders,
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
