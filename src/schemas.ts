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

// Apollo employee-count ranges are arbitrary "min,max" strings — NOT a fixed
// bucket enum. Apollo accepts any integer span (e.g. "250,500", "10001,"). We
// validate the SHAPE ("min,max" with an optional open-ended max) but never
// narrow the accepted spans. The legacy bucket values below remain valid (they
// are just specific instances of the shape) so existing callers keep working.
const EMPLOYEE_RANGE_REGEX = /^\d+,\d*$/;
const EXAMPLE_EMPLOYEE_RANGES = ["1,10", "250,500", "10001,"] as const;

// Apollo's full, faithful person-seniority set (developer/docs.apollo.io People
// Search). The first nine are the historical subset; `head` and `intern` are
// the two values Apollo accepts that were previously dropped — `head` is needed
// for "Head of Growth/Sales" audiences. Appended (not reordered) so the order
// stays stable; Apollo matches on the value, not the position.
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
  "head",
  "intern",
] as const;

// Apollo people-search range params are `{min, max}` objects with integer
// bounds (see CLAUDE.md "Apollo range filters are {min,max} objects"). Both
// bounds optional — an open-ended range omits the missing key.
const IntRangeSchema = z
  .object({
    min: z.number().int().optional(),
    max: z.number().int().optional(),
  })
  .openapi("IntRange");

// Date-bounded range params (e.g. organization_job_posted_at_range) use ISO
// `YYYY-MM-DD` string bounds, both optional.
const DateRangeSchema = z
  .object({
    min: z.string().min(1).optional(),
    max: z.string().min(1).optional(),
  })
  .openapi("DateRange");

const VALID_EMAIL_STATUSES = [
  "verified",
  "unverified",
  "likely to engage",
  "unavailable",
] as const;

/**
 * Discriminated union of error responses. Every 4xx/5xx body has a `type` field
 * so clients can switch on the failure mode without parsing strings.
 */
export const ErrorResponseSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        type: z.literal("validation"),
        error: z.string(),
        details: z.unknown().optional(),
      })
      .openapi("ValidationError"),
    z
      .object({
        type: z.literal("credit_insufficient"),
        error: z.string(),
        balance_cents: z.number().int(),
        required_cents: z.number().int(),
      })
      .openapi("CreditInsufficientError"),
    // Waterfall disabled 2026-05-28 — 504 waterfall_timeout no longer
    // emitted by /enrich or /match. Revive when re-enabling waterfall.
    // z
    //   .object({
    //     type: z.literal("waterfall_timeout"),
    //     error: z.string(),
    //     enrichmentId: z.string(),
    //   })
    //   .openapi("WaterfallTimeoutError"),
    z
      .object({
        type: z.literal("not_found"),
        error: z.string(),
      })
      .openapi("NotFoundError"),
    z
      .object({
        type: z.literal("internal"),
        error: z.string(),
      })
      .openapi("InternalError"),
  ])
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
  "x-audience-id": z.string().optional().openapi({ description: "Priority audience ID for per-audience cost attribution. Set on campaign-flow calls; absent otherwise.", example: "audience-1" }),
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
    organizationNumEmployeesRanges: z
      .array(z.string().regex(EMPLOYEE_RANGE_REGEX, "must be 'min,max' (e.g. '250,500' or '10001,' for open-ended)"))
      .optional()
      .openapi({
        description:
          "Filter by employer employee-count ranges. Apollo accepts ARBITRARY 'min,max' integer spans — not a fixed bucket list. Use an open-ended max ('10001,') for \"N or more\". Pass multiple spans to union them.",
        example: ["1,10", "250,500", "10001,"],
      }),
    qOrganizationIndustryTagIds: z.array(z.string().min(1)).optional().openapi({
      description: "Filter by industry names (use GET /reference/industries for valid values).",
      example: ["Information Technology and Services", "Computer Software"],
    }),
    qKeywords: z.string().optional().openapi({
      description: "Free-text keyword search across person and organization fields. Use OR to widen, AND to narrow.",
      example: "machine learning OR data science OR AI",
    }),
    personLocations: z.array(z.string().min(1)).optional().openapi({
      description: "Filter by person's location (city, state, country). Different from organizationLocations which filters by company HQ.",
      example: ["San Francisco, California, US", "New York, US"],
    }),
    personSeniorities: z.array(z.enum(VALID_SENIORITIES)).optional().openapi({
      description: "Filter by seniority level. Apollo's full set: entry, senior, manager, director, vp, c_suite, owner, founder, partner, head, intern. Use `head` for \"Head of X\" roles (e.g. Head of Growth/Sales) and `c_suite` for CxO.",
      example: ["head", "vp", "c_suite"],
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

    // ── Faithful Apollo People Search filters (additive — verbatim Apollo
    // vocabulary, full accepted value sets). See developer/docs.apollo.io. ──

    includeSimilarTitles: z.boolean().optional().openapi({
      description: "Apollo include_similar_titles. When false, personTitles match strictly; when true (Apollo default), Apollo also matches similar/equivalent titles. Set false to tighten an over-broad title match.",
      example: false,
    }),
    qOrganizationJobTitles: z.array(z.string().min(1)).optional().openapi({
      description: "Job titles listed in ACTIVE job postings at the person's current employer (hiring-signal targeting). Different from personTitles (the person's own title).",
      example: ["sales manager", "research analyst"],
    }),
    personLinkedinUrls: z.array(z.string().min(1)).optional().openapi({
      description: "Find specific people by their full LinkedIn profile URL.",
      example: ["https://www.linkedin.com/in/tim-zheng"],
    }),
    currentlyUsingAllOfTechnologyUids: z.array(z.string().min(1)).optional().openapi({
      description: "Match people whose current employer uses ALL of these technologies (Apollo technology UIDs; underscores for spaces/periods).",
      example: ["salesforce", "google_analytics"],
    }),
    currentlyNotUsingAnyOfTechnologyUids: z.array(z.string().min(1)).optional().openapi({
      description: "EXCLUDE people whose current employer uses ANY of these technologies (Apollo technology UIDs).",
      example: ["hubspot"],
    }),
    qOrganizationDomainsList: z.array(z.string().min(1)).optional().openapi({
      description: "Apollo's native organization-domain filter (q_organization_domains_list). Restrict to people at these company domains.",
      example: ["apollo.io", "google.com"],
    }),
    marketSegments: z.array(z.string().min(1)).optional().openapi({
      description: "Filter by the current employer's market-segment terms (matched against the employer's tags/name).",
      example: ["B2B", "Enterprise", "Healthcare"],
    }),
    organizationNaicsCodes: z.array(z.string().regex(/^\d{2,5}$/)).optional().openapi({
      description: "Match employers by NAICS industry code (2–5 digits; prefix match — a shorter code is broader).",
      example: ["5415", "54151"],
    }),
    notOrganizationNaicsCodes: z.array(z.string().regex(/^\d{2,5}$/)).optional().openapi({
      description: "EXCLUDE employers matching these NAICS codes (prefix match).",
      example: ["5415"],
    }),
    organizationSicCodes: z.array(z.string().regex(/^\d{4}$/)).optional().openapi({
      description: "Match employers by 4-digit SIC industry code.",
      example: ["7372", "5045"],
    }),
    notOrganizationSicCodes: z.array(z.string().regex(/^\d{4}$/)).optional().openapi({
      description: "EXCLUDE employers with these 4-digit SIC codes.",
      example: ["7372"],
    }),
    organizationJobLocations: z.array(z.string().min(1)).optional().openapi({
      description: "Locations of jobs the person's employer is actively recruiting for.",
      example: ["atlanta", "japan"],
    }),
    revenueRangeNative: IntRangeSchema.optional().openapi({
      description: "Native Apollo revenue_range as a {min,max} integer object (USD, no symbols/commas). Faithful alternative to the legacy string-array `revenueRange`; prefer this for new callers. If both are sent, this native object wins.",
      example: { min: 500000, max: 1500000 },
    }),
    organizationFoundedYearRange: IntRangeSchema.optional().openapi({
      description: "Filter by the employer's founding year, {min,max} (inclusive). Apollo advanced filter.",
      example: { min: 2015, max: 2020 },
    }),
    organizationIncludeUnknownFoundedYear: z.boolean().optional().openapi({
      description: "When true, also include people whose employer founding year is unknown (pairs with organizationFoundedYearRange).",
      example: false,
    }),
    organizationHeadcountGrowthPastNMonths: z.number().int().optional().openapi({
      description: "Trailing-month window over which to measure employer headcount growth (pairs with organizationHeadcountGrowthRange).",
      example: 6,
    }),
    organizationHeadcountGrowthRange: IntRangeSchema.optional().openapi({
      description: "Filter by employer headcount-growth PERCENT over the window, {min,max}.",
      example: { min: 10, max: 100 },
    }),
    organizationNumJobsRange: IntRangeSchema.optional().openapi({
      description: "Filter by the number of active job postings at the employer, {min,max} (hiring-intensity signal).",
      example: { min: 50, max: 500 },
    }),
    organizationJobPostedAtRange: DateRangeSchema.optional().openapi({
      description: "Filter by when the employer posted jobs, {min,max} as ISO YYYY-MM-DD dates.",
      example: { min: "2025-07-25", max: "2025-09-25" },
    }),
    personTotalYoeRange: IntRangeSchema.optional().openapi({
      description: "Filter by the person's TOTAL years of professional experience across their career, {min,max} (inclusive).",
      example: { min: 5, max: 15 },
    }),
    personDaysInCurrentTitleRange: IntRangeSchema.optional().openapi({
      description: "Filter by how long the person has held their current title, in DAYS, {min,max}. Convert from natural units (1yr=365, 1mo=30).",
      example: { min: 90, max: 730 },
    }),
  })
  .openapi("SearchFilters", {
    description: "Apollo search filters. All filters are combined using AND. Start broad and narrow down to avoid empty results.",
  });

// ─── GET /search/filters-prompt ─────────────────────────────────────────────

const FiltersPromptResponseSchema = z
  .object({
    prompt: z.string().openapi({
      description:
        "Markdown-formatted prompt fragment describing every field of SearchFiltersSchema. One block per field with type, optional enum values, an example, and a one-line description. Designed to be embedded in a caller's LLM system prompt.",
    }),
    schemaVersion: z.string().openapi({
      description:
        "Stable 12-char hex hash of the prompt content. Use as a cache key — same content always produces the same hash, so callers can safely cache by this value.",
    }),
  })
  .openapi("FiltersPromptResponse");

registry.registerPath({
  method: "get",
  path: "/search/filters-prompt",
  summary: "Get the filter-shape prompt fragment for caller LLMs",
  description:
    "Returns a markdown block documenting every filter accepted by /search/next and /search/dry-run, generated from SearchFiltersSchema. Single source of truth for callers (e.g. lead-service) that need to instruct an LLM how to build search filters. The schemaVersion is a stable hash of the prompt — cache by this value.",
  request: {
    headers: basicHeaders,
  },
  responses: {
    200: {
      description: "Filter-shape prompt and version hash",
      content: { "application/json": { schema: FiltersPromptResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
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
    cached: z.boolean().openapi({
      description: "True if the result was served from the 12-month cache (no Apollo API call, no cost).",
    }),
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
    brandIds: z.array(z.string()).optional().openapi({
      description: "Filter by one or more brand IDs (rows whose brand_ids array overlaps with this list).",
      example: ["brand-1", "brand-2"],
    }),
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

// ─── Apollo audiences (stateful: persisted faithful Apollo filter sets) ───────

const audienceHeaders = z.object({
  "x-api-key": z.string().optional(),
  "x-org-id": z.string(),
  "x-user-id": z.string(),
  "x-brand-id": z.string().optional(),
  "x-run-id": z.string().optional(),
});

const audienceOrgHeaders = z.object({
  "x-api-key": z.string().optional(),
  "x-org-id": z.string(),
});

export const SuggestFromSegmentRequestSchema = z
  .object({
    name: z.string().min(1).openapi({ description: "Short human label for the audience.", example: "US fintech heads of growth" }),
    description: z.string().min(1).openapi({
      description: "Self-contained natural-language description of the target segment. Drives the agentic NL→faithful-Apollo-filters refine loop.",
      example: "Heads of growth and VPs of marketing at US-based Series A–C fintech companies with 50–500 employees.",
    }),
    brandId: z.string().nullable().openapi({ description: "Owning brand, or null.", example: "brand-1" }),
  })
  .openapi("SuggestFromSegmentRequest");

const SuggestFromSegmentResponseSchema = z
  .object({
    apolloAudienceId: z.string().openapi({ description: "Persisted apollo-audience id. human-service stores ONLY this pointer." }),
    filters: SearchFiltersSchema.openapi({ description: "The confirmed faithful Apollo filter object." }),
    count: z.number().int().openapi({ description: "Live match-count snapshot for the confirmed filters." }),
  })
  .openapi("SuggestFromSegmentResponse");

const AudienceResponseSchema = z
  .object({
    apolloAudienceId: z.string(),
    filters: SearchFiltersSchema,
    count: z.number().int(),
    status: z.string().openapi({ description: '"confirmed" or "exhausted".' }),
    createdAt: z.string(),
  })
  .openapi("AudienceResponse");

const AudienceDryRunResponseSchema = z
  .object({
    count: z.number().int().openapi({ description: "Fresh live match-count for the stored filters." }),
  })
  .openapi("AudienceDryRunResponse");

registry.registerPath({
  method: "post",
  path: "/audiences/suggest-from-segment",
  summary: "Build + persist a faithful Apollo audience from a natural-language segment",
  description:
    "Runs the agentic NL→faithful-Apollo-filters refine loop (LLM via chat-service, free Apollo dry-runs for live counts), then persists the confirmed audience. Returns the apollo-audience id, the faithful filters, and the count snapshot. The LLM cost is owned by chat-service; this endpoint declares no cost (dry-runs are free).",
  request: {
    headers: audienceHeaders,
    body: {
      content: { "application/json": { schema: SuggestFromSegmentRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Persisted audience",
      content: { "application/json": { schema: SuggestFromSegmentResponseSchema } },
    },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorResponseSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/audiences/{apolloAudienceId}",
  summary: "Fetch a persisted Apollo audience by id",
  request: {
    headers: audienceOrgHeaders,
    params: z.object({ apolloAudienceId: z.string() }),
  },
  responses: {
    200: {
      description: "The audience",
      content: { "application/json": { schema: AudienceResponseSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponseSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/audiences/{apolloAudienceId}/dry-run",
  summary: "Re-count a persisted Apollo audience (free dry-run)",
  description:
    "Re-runs the free Apollo dry-run against the stored filters and returns a fresh count. Also refreshes the stored count snapshot. No credits consumed.",
  request: {
    headers: audienceHeaders,
    params: z.object({ apolloAudienceId: z.string() }),
  },
  responses: {
    200: {
      description: "Fresh match count",
      content: { "application/json": { schema: AudienceDryRunResponseSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponseSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});
