import { z } from "zod";
import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
} from "@asteasolutions/zod-to-openapi";
import { APOLLO_INDUSTRY_VALUES } from "./lib/reference-cache.js";

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

const ApolloIndustryValueSchema = z.enum(APOLLO_INDUSTRY_VALUES);

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
 * "The provider cannot serve us" — present on an error body ONLY when the
 * failure is the upstream provider being unable to serve, never on an ordinary
 * or transient failure. Switch on `code`; never parse `message`.
 *
 * `retryable: false` means the same call will keep failing until the provider
 * recovers (Apollo credits topped up), so repeating it is not worth it. What to
 * DO about that (stop the campaign, tell the customer) is the caller's call —
 * this service only states the truth. See `src/lib/provider-error.ts`.
 */
export const ProviderErrorSchema = z
  .object({
    provider: z.enum(["apollo", "apify"]).describe("Upstream provider that could not serve the request: apollo (lead credits) or apify (BounceVerify email verification, monthly usage limit)"),
    code: z
      .literal("provider_credits_exhausted")
      .describe("Stable machine-readable state: the provider is out of credits"),
    retryable: z
      .literal(false)
      .describe("Retrying will keep failing until the provider recovers"),
    message: z.string().describe("Human-readable explanation — do not parse"),
  })
  .openapi("ProviderError");

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
        error: z.string().describe('"Insufficient credits" for a balance shortfall; "Sales funnel max budget reached" (or "Sales funnel max budget unreadable") when a campaign max budget refused the spend.'),
        balance_cents: z.number().int(),
        required_cents: z.number().int(),
        reason: z
          .string()
          .optional()
          .describe("billing-service's reason, verbatim. Present ONLY when a sales funnel MAX BUDGET refused the spend (sales_funnel_max_budget_reached | sales_funnel_max_budget_unreadable): raise that campaign's max budget, adding credit changes nothing. Absent on a balance shortfall."),
        sales_funnel_cap: z
          .object({
            salesFunnelId: z.string(),
            salesFunnelCampaignId: z.string().nullable(),
            amountCents: z.string(),
            period: z.string(),
            consumedCents: z.string().nullable(),
            reservedCents: z.string(),
          })
          .optional()
          .describe("The max budget that refused the spend, verbatim from billing-service; present only with `reason`."),
        source: z.string().optional(),
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
        providerError: ProviderErrorSchema.optional(),
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
    timeZone: z.string().nullable().optional().openapi({
      description:
        "Recipient's IANA timezone (e.g. \"America/New_York\"), sourced from Apollo's person time_zone. Null when Apollo has none. Carried downstream to schedule cold-email sends in the prospect's local business hours.",
      example: "America/New_York",
    }),
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
    organizationAnnualRevenue: z.number().nullable().optional().openapi({
      description:
        "Organization annual revenue in USD (numeric). Sourced from the stored organization_revenue_usd; null when absent.",
    }),
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

export const ApolloNativeSearchFiltersSchema = z
  .object({
    person_titles: z.array(z.string().min(1)).optional().openapi({
      description: "Filter by job titles.",
      example: ["CEO", "CTO", "VP Engineering"],
    }),
    include_similar_titles: z.boolean().optional().openapi({
      description: "When false, return only strict matches for person_titles. When true or omitted, Apollo may include similar titles.",
      example: false,
    }),
    q_keywords: z.string().optional().openapi({
      description: "Free-text keyword search across person and organization fields.",
      example: "machine learning OR data science OR AI",
    }),
    person_locations: z.array(z.string().min(1)).optional().openapi({
      description: "Filter by where the PERSON is (city, state, country). This is the one that answers 'people in X'. It is NOT organization_locations, which filters on where the EMPLOYER is headquartered — a person working in X for a company headquartered elsewhere matches this field and not that one, and vice versa. Pick the one that answers the question actually asked.",
      example: ["San Francisco, California, US", "New York, US"],
    }),
    person_seniorities: z.array(z.enum(VALID_SENIORITIES)).optional().openapi({
      description: "Filter by seniority level. Apollo's full set: owner, founder, c_suite, partner, vp, head, director, manager, senior, entry, intern.",
      example: ["head", "vp", "c_suite"],
    }),
    organization_locations: z.array(z.string().min(1)).optional().openapi({
      description: "Filter by where the EMPLOYER is headquartered. This answers 'companies based in X', not 'people in X' — for the latter use person_locations. A multi-site employer is matched on its HQ only, so this silently drops that employer's staff everywhere else.",
      example: ["United States", "California, US"],
    }),
    organization_industries: z.array(ApolloIndustryValueSchema).optional().openapi({
      description:
        "Filter by Apollo's native employer industry taxonomy. Use lowercase values from this enum when the user's industry maps cleanly to Apollo; for niche sectors with no enum value, use q_organization_keyword_tags instead.",
      example: ["pharmaceuticals", "biotechnology", "medical devices"],
    }),
    q_organization_domains_list: z.array(z.string().min(1)).optional().openapi({
      description: "Restrict to people at these company domains. Do not include www, @, or protocol.",
      example: ["apollo.io", "google.com"],
    }),
    contact_email_status: z.array(z.enum(VALID_EMAIL_STATUSES)).optional().openapi({
      description: "Filter by email verification status. Valid values: verified, unverified, likely to engage, unavailable. NOTE: this service FORCES contact_email_status:['verified'] on every Apollo people-search (count, serve, refine) — verified-only is the standard, so any value passed here is overridden. See VERIFIED_EMAIL_STATUS in apollo-client.",
      example: ["verified"],
    }),
    organization_ids: z.array(z.string().min(1)).optional().openapi({
      description: "Filter by specific Apollo organization IDs.",
      example: ["5f5e100a01d6b1000169c754"],
    }),
    organization_num_employees_ranges: z
      .array(z.string().regex(EMPLOYEE_RANGE_REGEX, "must be 'min,max' (e.g. '250,500' or '10001,' for open-ended)"))
      .optional()
      .openapi({
        description:
          "Filter by employer employee-count ranges. Apollo accepts ARBITRARY 'min,max' integer spans, not a fixed bucket list. Use an open-ended max ('10001,') for \"N or more\". Pass multiple spans to union them.",
        example: ["1,10", "250,500", "10001,"],
      }),
    revenue_range: IntRangeSchema.optional().openapi({
      description: "Filter by employer annual revenue as {min,max} integer USD bounds. Do not use currency symbols, commas, or decimals.",
      example: { min: 500000, max: 1500000 },
    }),
    currently_using_all_of_technology_uids: z.array(z.string().min(1)).optional().openapi({
      description: "Match people whose current employer uses ALL of these technologies. Use Apollo technology UIDs with underscores for spaces/periods.",
      example: ["salesforce", "google_analytics"],
    }),
    currently_using_any_of_technology_uids: z.array(z.string().min(1)).optional().openapi({
      description: "Match people whose current employer uses ANY of these technologies. Use Apollo technology UIDs with underscores for spaces/periods.",
      example: ["salesforce", "hubspot"],
    }),
    currently_not_using_any_of_technology_uids: z.array(z.string().min(1)).optional().openapi({
      description: "EXCLUDE people whose current employer uses ANY of these technologies.",
      example: ["hubspot"],
    }),
    q_organization_job_titles: z.array(z.string().min(1)).optional().openapi({
      description: "Job titles listed in active job postings at the person's current employer.",
      example: ["sales manager", "research analyst"],
    }),
    organization_job_locations: z.array(z.string().min(1)).optional().openapi({
      description: "Locations of jobs the person's employer is actively recruiting for.",
      example: ["atlanta", "japan"],
    }),
    organization_num_jobs_range: IntRangeSchema.optional().openapi({
      description: "Filter by the number of active job postings at the employer, {min,max} (hiring-intensity signal).",
      example: { min: 50, max: 500 },
    }),
    organization_job_posted_at_range: DateRangeSchema.optional().openapi({
      description: "Filter by when the employer posted jobs, {min,max} as ISO YYYY-MM-DD dates.",
      example: { min: "2025-07-25", max: "2025-09-25" },
    }),
    // ── UNDOCUMENTED-but-verified org-funding filters ──
    // Apollo documents these for Organization Search only, but the People Search
    // endpoint (mixed_people/api_search) HONORS them (verified live 2026-06-25
    // via the free dry-run). See the "UNDOCUMENTED FILTERS" note appended to the
    // filters prompt and CLAUDE.md. Do NOT delete when re-syncing to the doc.
    total_funding_range: IntRangeSchema.optional().openapi({
      description: "Filter by employer TOTAL funding raised across all rounds, {min,max} integer USD. Undocumented for People Search but honored.",
      example: { min: 1000000, max: 50000000 },
    }),
    latest_funding_amount_range: IntRangeSchema.optional().openapi({
      description: "Filter by the amount of the employer's MOST RECENT funding round, {min,max} integer USD. Undocumented for People Search but honored.",
      example: { min: 5000000 },
    }),
    latest_funding_date_range: DateRangeSchema.optional().openapi({
      description: "Filter by the date of the employer's most recent funding round, {min,max} as ISO YYYY-MM-DD dates. Undocumented for People Search but honored.",
      example: { min: "2024-01-01" },
    }),
    organization_latest_funding_stage_cd: z.array(z.string().min(1)).optional().openapi({
      description: "Filter by employer's latest funding STAGE using Apollo NUMERIC stage codes (label strings like 'Series A' do NOT filter). Code map (certified via enrichment): 1=Angel, 2=Series A, 3=Series B, 4=Series C, 5=Series D, 6=Series E, 7=Series F, 8=Series G, 9=Series H, 10=Venture (Round not Specified), 11=Private Equity, 12=Other, 13=Debt Financing, 14=Equity Crowdfunding, 15=Convertible Note. NOTE: Seed is code 0 in Apollo but People Search does NOT filter on it (code 0 returns the 'has any stage' fallback), so Seed is not addressable here. See the UNDOCUMENTED FILTERS note. Undocumented for People Search but honored.",
      example: ["2", "3"],
    }),
    // ── UNDOCUMENTED-but-verified TARGETING filters ──
    // Documented for Apollo Organization Search / absent from the People Search
    // doc, but mixed_people/api_search HONORS them (verified live 2026-06-25 via
    // the free dry-run, baseline `CEO + United States` = 521,875). See the
    // "UNDOCUMENTED FILTERS" encart + CLAUDE.md. Do NOT delete on a doc re-sync.
    q_organization_keyword_tags: z.array(z.string().min(1)).optional().openapi({
      description:
        "Target a sector/vertical by employer KEYWORD TAGS (industry-style names). The VOLUME-FRIENDLY way to express 'SaaS', 'fintech', etc. — far higher volume than the free-text q_keywords (verified: q_keywords='SaaS' -> 86 matches vs q_organization_keyword_tags=['software'] -> 128,274). Prefer this over q_keywords for any industry/vertical concept. Undocumented for People Search but honored.",
      example: ["software", "fintech"],
    }),
    q_not_organization_keyword_tags: z.array(z.string().min(1)).optional().openapi({
      description:
        "EXCLUDE people whose employer matches these keyword tags. An employer is removed when ANY ONE of the listed tags is on it, so each value added removes more people, and an employer carrying a listed tag incidentally alongside the tags you are targeting removes itself too. Use this q_-prefixed form — the plain not_organization_keyword_tags spelling is silently dropped. Undocumented for People Search but honored.",
      example: ["staffing", "recruiting"],
    }),
    included_organization_keyword_fields: z
      .array(z.enum(["tags", "name", "social_media_description"]))
      .optional()
      .openapi({
        description:
          "Restrict which employer fields q_organization_keyword_tags matches against. OMIT IT to match against employer TAGS, which is Apollo's default and almost always what is wanted. What it COSTS: restricting to ['name'] matches only companies whose literal NAME contains the term, so an employer tagged as the thing you are looking for but not NAMED after it disappears — measured live, one country held fixed, the same set went from 100 people to 7 by adding ['name'] alone (a 14x collapse). It reads like a precision improvement and is an order-of-magnitude cut. Verified honored values: tags, name, social_media_description (seo_description is silently ignored). Undocumented for People Search but honored.",
        example: ["tags"],
      }),
    organization_trading_status: z.array(z.enum(["private", "public"])).optional().openapi({
      description:
        "Filter by employer public/private status. Only 'private' and 'public' filter (delisted/acquired/ipo/subsidiary/otc are silently dropped). Undocumented for People Search but honored.",
      example: ["private"],
    }),
    person_functions: z.array(z.string().min(1)).optional().openapi({
      description:
        "Filter by the person's job FUNCTION (broad role family), lowercase_underscore slugs. Verified honored: accounting, administrative, arts_and_design, business_development, consulting, data_science, education, engineering, entrepreneurship, finance, human_resources, information_technology, legal, marketing, operations, product_management, sales, support. An unknown slug returns 0 matches (not a 422). Undocumented for People Search but honored.",
      example: ["sales", "marketing"],
    }),
    person_department_or_subdepartments: z.array(z.string().min(1)).optional().openapi({
      description:
        "Filter by the person's DEPARTMENT (master_* slug) or subdepartment (leaf slug). Verified honored master_* values: master_engineering_technical, master_information_technology, master_finance, master_sales, master_operations, master_marketing, master_human_resources, master_legal. Leaf subdepartment slugs (e.g. 'sales', 'information_technology') also work; an unknown slug returns 0. Undocumented for People Search but honored.",
      example: ["master_sales", "master_engineering_technical"],
    }),
    q_person_name: z.string().optional().openapi({
      description: "Free-text search on the person's full name. Undocumented for People Search but honored.",
      example: "jane smith",
    }),
    person_not_titles: z.array(z.string().min(1)).optional().openapi({
      description: "EXCLUDE people whose current title matches any of these. Undocumented for People Search but honored.",
      example: ["intern", "assistant"],
    }),
  })
  .strict()
  .openapi("SearchFilters", {
    description: "Apollo People API Search filters using Apollo-native field names. All filters are combined using AND. Start broad and narrow down to avoid empty results.",
  });

const LegacySearchFilterAliasesSchema = z.object({
  personTitles: z.array(z.string().min(1)).optional(),
  qOrganizationKeywordTags: z.array(z.string().min(1)).optional(),
  organizationLocations: z.array(z.string().min(1)).optional(),
  organizationNumEmployeesRanges: z
    .array(z.string().regex(EMPLOYEE_RANGE_REGEX, "must be 'min,max' (e.g. '250,500' or '10001,' for open-ended)"))
    .optional(),
  qOrganizationIndustryTagIds: z.array(z.string().min(1)).optional(),
  qKeywords: z.string().optional(),
  personLocations: z.array(z.string().min(1)).optional(),
  personSeniorities: z.array(z.enum(VALID_SENIORITIES)).optional(),
  // NOTE: Apollo's People Search HONORS contact_email_status — it is NOT a
  // phantom filter. Verified live 2026-07-21: "Chiropractor + US" 16,220 total
  // → 4,068 with ["verified"] (~25%). This service now FORCES ["verified"] on
  // every people-search (searchPeople, see VERIFIED_EMAIL_STATUS), so counts +
  // serve pagination reflect the reachable pool. This alias field is kept for
  // API faithfulness but is OVERRIDDEN — verified-only is the standard.
  contactEmailStatus: z.array(z.enum(VALID_EMAIL_STATUSES)).optional(),
  qOrganizationDomains: z.array(z.string().min(1)).optional(),
  currentlyUsingAnyOfTechnologyUids: z.array(z.string().min(1)).optional(),
  revenueRange: z.array(z.string().min(1)).optional(),
  organizationIds: z.array(z.string().min(1)).optional(),
  includeSimilarTitles: z.boolean().optional(),
  qOrganizationJobTitles: z.array(z.string().min(1)).optional(),
  personLinkedinUrls: z.array(z.string().min(1)).optional(),
  currentlyUsingAllOfTechnologyUids: z.array(z.string().min(1)).optional(),
  currentlyNotUsingAnyOfTechnologyUids: z.array(z.string().min(1)).optional(),
  qOrganizationDomainsList: z.array(z.string().min(1)).optional(),
  marketSegments: z.array(z.string().min(1)).optional(),
  organizationNaicsCodes: z.array(z.string().regex(/^\d{2,5}$/)).optional(),
  notOrganizationNaicsCodes: z.array(z.string().regex(/^\d{2,5}$/)).optional(),
  organizationSicCodes: z.array(z.string().regex(/^\d{4}$/)).optional(),
  notOrganizationSicCodes: z.array(z.string().regex(/^\d{4}$/)).optional(),
  organizationJobLocations: z.array(z.string().min(1)).optional(),
  revenueRangeNative: IntRangeSchema.optional(),
  organizationFoundedYearRange: IntRangeSchema.optional(),
  organizationIncludeUnknownFoundedYear: z.boolean().optional(),
  organizationHeadcountGrowthPastNMonths: z.number().int().optional(),
  organizationHeadcountGrowthRange: IntRangeSchema.optional(),
  organizationNumJobsRange: IntRangeSchema.optional(),
  organizationJobPostedAtRange: DateRangeSchema.optional(),
  personTotalYoeRange: IntRangeSchema.optional(),
  personDaysInCurrentTitleRange: IntRangeSchema.optional(),
  organization_industry_tag_ids: z.array(z.string().min(1)).optional(),
}).strict();

// ── Buying signal (distribute-owned, NOT an Apollo field) ──
// A RELATIVE recency criterion ("companies hiring in the last 30 days") that
// apollo-service materializes into Apollo's own date filters at call time
// (src/lib/buying-signals.ts). Relative on purpose: a consumer stores the
// filters once and forwards them verbatim, and the window keeps rolling. Kept
// OUT of ApolloNativeSearchFiltersSchema so the refine loop and
// /search/filters-prompt never offer it — a signal audience is a staff choice.
export const APOLLO_BUYING_SIGNAL_TYPES = ["hiring", "job_change", "funding"] as const;
// linkedin_engagement is served from competitor LinkedIn post engagement, not
// from Apollo (src/lib/linkedin-engagement.ts).
export const BUYING_SIGNAL_TYPES = [...APOLLO_BUYING_SIGNAL_TYPES, "linkedin_engagement"] as const;
const LINKEDIN_COMPANY_PAGE_RE = /^(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/(company|showcase)\/[^/?#\s]+\/?(?:[?#].*)?$/i;
const CompetitorPagesSchema = z
  .array(z.string().regex(LINKEDIN_COMPANY_PAGE_RE, "must be a LinkedIn company page URL (https://www.linkedin.com/company/<slug>/)"))
  .min(1)
  .max(3);
const IsoDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

export const BuyingSignalFilterSchema = z
  .object({
    type: z.enum(BUYING_SIGNAL_TYPES).openapi({
      description:
        "hiring = the employer posted a job in the window (Apollo organization_job_posted_at_range, optionally narrowed by job_titles); job_change = the person started their current title in the window (Apollo person_days_in_current_title_range); funding = the employer's latest funding round falls in the window (Apollo latest_funding_date_range); linkedin_engagement = the person reacted to or commented on a post of one of competitor_pages published in the window (NOT an Apollo search: served from LinkedIn engagement, each person's email found and verified on /enrich).",
    }),
    window_days: z.number().int().min(1).max(365).openapi({
      description: "Recency window in days, counted back from the day the audience is served (rolling). linkedin_engagement: the age of the competitor posts whose engagers are served.",
      example: 30,
    }),
    competitor_pages: CompetitorPagesSchema.optional().openapi({
      description: "linkedin_engagement only (required there): 1-3 competitor LinkedIn company page URLs whose post engagers are the audience.",
      example: ["https://www.linkedin.com/company/lemlist/"],
    }),
    job_titles: z.array(z.string().min(1)).optional().openapi({
      description: "hiring only: roles the employer is hiring for (Apollo q_organization_job_titles). Omit for any role.",
      example: ["head of sales"],
    }),
    as_of: IsoDaySchema.optional().openapi({
      description: "Set by apollo-service on a served cohort (the day it was materialized). Callers omit it.",
    }),
    since: IsoDaySchema.optional().openapi({
      description: "Set by apollo-service on a follow-up cohort: only signals after the previous cohort's day. Callers omit it.",
    }),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.job_titles && v.type !== "hiring") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["job_titles"], message: "job_titles is only valid for type=hiring" });
    }
    if (v.type === "linkedin_engagement" && !v.competitor_pages) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["competitor_pages"], message: "competitor_pages (1-3 LinkedIn company page URLs) is required for type=linkedin_engagement" });
    }
    if (v.competitor_pages && v.type !== "linkedin_engagement") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["competitor_pages"], message: "competitor_pages is only valid for type=linkedin_engagement" });
    }
  })
  .openapi("BuyingSignalFilter");

const BuyingSignalExtensionSchema = z
  .object({
    buying_signal: BuyingSignalFilterSchema.optional().openapi({
      description:
        "Distribute-owned relative buying-signal criterion (not an Apollo field). apollo-service turns it into Apollo's date filters for the current window at every call, so the audience fills continuously. Must not be combined with the Apollo field it drives.",
    }),
  })
  .strict();

export const SearchFiltersSchema = ApolloNativeSearchFiltersSchema
  .merge(LegacySearchFilterAliasesSchema)
  .merge(BuyingSignalExtensionSchema)
  .strict()
  .openapi("SearchFiltersRuntime", {
    description:
      "Runtime Apollo People API Search filters. New callers should use Apollo-native field names; camelCase fields are deprecated compatibility aliases.",
  });

// ─── GET /search/filters-prompt ─────────────────────────────────────────────

const FiltersPromptResponseSchema = z
  .object({
    prompt: z.string().openapi({
      description:
        "Markdown-formatted prompt fragment describing every Apollo-native People Search filter field. One block per field with type, optional enum values, an example, and a one-line description. Designed to be embedded in a caller's LLM system prompt.",
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
    "Returns a markdown block documenting the Apollo-native People Search filter vocabulary. Single source of truth for callers that need to instruct an LLM how to build search filters. Deprecated compatibility aliases accepted by runtime routes are intentionally hidden. The schemaVersion is a stable hash of the prompt — cache by this value.",
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
      description: "Search filters. Provide them to create or resume the cursor for THIS exact filter set. Re-passing the same filters resumes from the stored page (never resets to page 1); a different filter set gets its own cursor and walks its own pool. Omit to resume the campaign's most recently used, non-exhausted cursor.",
    }),
  })
  .openapi("SearchNextRequest", {
    description: "Request body for server-managed search pagination. The cursor is keyed by (orgId, x-campaign-id header, searchParams) — one cursor per distinct filter set, so multiple filter sets for one campaign no longer evict each other.",
  });

const SearchNextResponseSchema = z
  .object({
    people: z.array(PersonSchema).openapi({ description: "People returned for this page. Empty array when done=true. On the Apollo walk each teaser's organizationDomain is the employer's web domain whenever it can be known for free: Apollo's own, else Apollo's FREE organization name lookup when exactly ONE organization carries exactly the employer name. No match, several, or a lookup not answered within the page's budget ⟹ organizationDomain absent (never guessed). No Apollo credit is spent for it." }),
    done: z.boolean().openapi({ description: "True ONLY when every page of this filter set's pool has been walked (true pool exhaustion). A page that returns few/no servable people is NOT exhaustion — done stays false and the caller must keep pulling. Do not stop on an empty/low-yield page while done=false." }),
    totalEntries: z.number().openapi({ description: "Total number of people matching the search filters across all pages." }),
    page: z.number().openapi({ description: "The page number just fetched (1-based)." }),
    totalPages: z.number().openapi({ description: "Total pages for this filter set's pool, clamped to Apollo's reachable window (500). exhaustion happens when the next page would exceed this." }),
    hasMore: z.boolean().openapi({ description: "Convenience inverse of done — true when more pages remain to fetch for this filter set." }),
    doneReason: z.enum(["no_recent_posts", "no_engagers", "all_served"]).nullable().optional().openapi({
      description: "source=linkedin_engagement only (absent everywhere else). WHY done is what it is: null while done=false; when done=true, no_recent_posts = no competitor page has a post published inside the audience's window (nothing to read engagers from: NOT exhaustion of an engaged pool, new posts may come), no_engagers = posts exist inside the window but nobody reacted or commented, all_served = there were engagers and every one was already considered for this audience (served, competitor employee or profile unreadable).",
    }),
    source: z.enum(["quickenrich", "linkedin_engagement"]).optional().openapi({
      description: "quickenrich: this page came from the FREE QuickEnrich search (the audience is switched to quickenrich); those people carry an id `qe:<emp_id>`, their full name, LinkedIn URL and company domain. linkedin_engagement: the filters carry a linkedin_engagement buying_signal; up to 5 engagers of the competitor pages per call, each with an id `li:<profileId>`, full name, title, headline, employer and LinkedIn URL, never the same person twice for the audience (x-audience-id, else the campaign), competitor employees excluded; done=true only once nobody is left. For both, POST /enrich with that id finds the email with treg and verifies it. Absent = the Apollo walk, unchanged.",
    }),
  })
  .openapi("SearchNextResponse", {
    description: "One page of search results with pagination state. Distinguish true pool-exhaustion (done=true) from a low-yield page (done=false, hasMore=true).",
  });

registry.registerPath({
  method: "post",
  path: "/search/next",
  summary: "Get next page of search results for a campaign",
  description:
    "Server-managed pagination keyed by (org, campaign, filter set). First call with a filter set creates a cursor at page 1; re-passing the SAME filter set resumes it (no reset). A different filter set gets its OWN cursor and walks its own pool — filter sets for one campaign no longer evict each other. Each call returns one page of 100 people and advances that filter set's cursor. done=true is set only when the next page is past Apollo's totalPages (true pool exhaustion); transient mid-stream empty / low-yield pages do NOT exhaust the cursor (done stays false, hasMore=true — keep pulling).",
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

export const EmailVerificationObjectSchema = z
  .object({
    email: z.string().openapi({ description: "The verified address, lower-cased." }),
    verdict: z.enum(["valid", "invalid", "catch_all", "risky", "unknown"]).openapi({
      description: "The FINAL verdict. Step 1 = ONE verdict from the cheapest verifier that ANSWERS: ContactOut (free) → BounceVerify (Apify) → TryKitt → MillionVerifier, the next asked only when one fails to answer. Step 2 = a step-1 catch_all or unknown goes to BounceBan, whose verdict decides.",
    }),
    deliverable: z.boolean().openapi({
      description: "THE switch: true only for verdict `valid`. false = revealed but not deliverable — do not send; the person is still returned so the caller can suppress them.",
    }),
    verifier: z.string().openapi({
      description: "Who decided the verdict: the step-1 verifier that answered (\"contactout\", \"bounceverify\", \"trykitt\", \"millionverifier\") or \"bounceban\" (step 2).",
    }),
    verificationId: z.string().uuid(),
    verifiedAt: z.string(),
    reused: z.boolean().openapi({ description: "true = a final verdict under 30 days old was reused; nothing billed." }),
  })
  .openapi("EmailVerificationVerdict");

export const EmailVerificationSchema = EmailVerificationObjectSchema
  .nullable()
  .openapi("EmailVerification", {
    description:
      "Pre-serve verification of the revealed email. null when there is no email. Billed per vendor: apify-bounceverify-email (decisive BounceVerify verdicts only) and treg-micro-usd (ContactOut, TryKitt, MillionVerifier, BounceBan), each at the vendor's own charge. A verification that fails answers 502 {type: \"email_verification\"} — an unverified email is never returned as deliverable.",
  });

export const BuyingSignalEvidenceSchema = z
  .object({
    type: z.enum(BUYING_SIGNAL_TYPES),
    engagement: z
      .object({
        competitorPage: z.string(),
        postUrl: z.string().nullable(),
        postPublishedOn: z.string().nullable().openapi({ description: "Approximate (LinkedIn gives a relative age)." }),
        kind: z.enum(["reaction", "comment"]),
        reactionType: z.string().nullable(),
        commentText: z.string().nullable(),
        commentedAt: z.string().nullable(),
      })
      .optional()
      .openapi({ description: "linkedin_engagement only: which competitor post, reaction or comment, and when. A reaction carries no date of its own: occurredOn is then the post's (approximate) publication day." }),
    occurredOn: z.string().openapi({ description: "Day the signal happened (YYYY-MM-DD), as Apollo recorded it.", example: "2026-09-21" }),
    fact: z.string().openapi({
      description: "One English sentence stating the signal, for the email writer to reference.",
      example: "Acme Clinics posted a job for Office Manager (Austin, United States) on September 21, 2026",
    }),
    source: z.string().openapi({ description: "apollo:job_postings (hiring), apollo:enrichment (funding, job_change) or linkedin:company/<slug> (linkedin_engagement).", example: "apollo:job_postings" }),
    sourceUrl: z.string().nullable().openapi({ description: "The posting or news link when Apollo gives one." }),
  })
  .openapi("BuyingSignalEvidence");

const EnrichResponseSchema = z
  .object({
    enrichmentId: z.string().nullable(),
    person: PersonSchema.nullable(),
    buyingSignal: BuyingSignalEvidenceSchema.nullable().optional().openapi({
      description:
        "The buying signal this person's audience matched (hiring / job_change / funding), with its date and a one-line fact. Present on Apollo reveals; null when the person was not served by a buying-signal audience or Apollo holds no dated evidence in the window (never invented). Hiring evidence is Apollo's job postings for the employer: 1 apollo-credit per company per 7 days, billed to this org (0 when Apollo has no postings).",
    }),
    cached: z.boolean().openapi({
      description: "True if the result was served from the 12-month cache (no Apollo API call, no cost).",
    }),
    emailVerification: EmailVerificationSchema,
    source: z.literal("quickenrich").optional().openapi({
      description: "Present when apolloPersonId was a `qe:<emp_id>` QuickEnrich person: the email was found with treg (no Apollo credit; cost `treg-micro-usd`) and verified. `cached` then means the finding was reused (no vendor call).",
    }),
    findingId: z.string().optional().openapi({ description: "The treg finding (email_findings) that answered, when source=quickenrich." }),
    revealSkipped: z
      .object({
        skipId: z.string().openapi({ description: "Row in reveal_skips." }),
        reason: z.enum(["catch_all_domain", "checker_blocked_domain"]),
        organizationName: z.string(),
        organizationId: z.string(),
        evidence: z.array(
          z.object({
            domain: z.string(),
            verdict: z.string().nullable(),
            verificationId: z.string().nullable(),
            verifiedAt: z.string().nullable(),
            probed: z.boolean(),
          })
        ),
      })
      .optional()
      .openapi({
        description:
          "Present when the Apollo reveal was NOT bought: every mail domain of the person's employer is catch-all (no address on it can verify valid) or refuses the verifier (unknown, re-probed after 7 days). person is then null and no apollo-credit is spent; a domain the fleet never verified is probed with one random address (apify-bounceverify-email, decisive verdicts only).",
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
    headers: runContextHeaders.extend({
      "x-campaign-id": z.string().optional().openapi({
        description:
          "Campaign ID. Optional on /enrich only: a reveal made outside any campaign (e.g. signed-out onboarding) is the same billed, verified, cached reveal, recorded with campaign_id NULL.",
        example: "campaign-1",
      }),
    }),
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
    502: {
      description: "The revealed email could not be verified (type email_verification). The reveal is cached; a retry re-runs only the verification.",
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
    emailVerification: EmailVerificationSchema,
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
    502: {
      description: "The revealed email could not be verified (type email_verification). The reveal is cached; a retry re-runs only the verification.",
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
    timeZone: z.string().nullable().optional().openapi({
      description:
        "Recipient's IANA timezone (e.g. \"America/New_York\") for local-time send. Null when Apollo has none.",
      example: "America/New_York",
    }),
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
  .object({
    name: z.string(),
    value: ApolloIndustryValueSchema,
  })
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
  summary: "Transfer a brand's rows from one org to another",
  description:
    "Moves every row this service holds for the brand from sourceOrgId to targetOrgId, in one transaction: rows carrying the brand alone (people searches, enrichments, search cursors, audiences, phone reveals, email findings) and rows tied to it through one of its campaigns, runs, cursors, audiences or findings (email finder calls, email verifications, QuickEnrich searches). A solo brand reference is rewritten to targetBrandId when given. Co-branded rows (several brand IDs) are left in place. History only: no cost is declared or reversed. Requires x-api-key = APOLLO_SERVICE_API_KEY. Idempotent: a second call reports 0 for every table.",
  request: {
    headers: z.object({ "x-api-key": z.string() }),
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
    401: {
      description: "Missing or invalid x-api-key",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ─── POST /internal/cost-holds/reconcile ─────────────────────────────────

export const ReconcileHoldsRequestSchema = z
  .object({
    dryRun: z.boolean(),
    olderThanMinutes: z.number().int().positive().optional(),
    limit: z.number().int().positive().max(1000).optional(),
  })
  .openapi("ReconcileHoldsRequest");

const ReconcileHoldsResponseSchema = z
  .object({
    dryRun: z.boolean(),
    examined: z.number().int(),
    items: z.array(
      z
        .object({
          costId: z.string(),
          runId: z.string(),
          orgId: z.string(),
          costName: z.string(),
          quantity: z.string(),
          taskName: z.string().nullable(),
          decision: z.object({ kind: z.string(), reason: z.string() }).passthrough(),
          runClosedAs: z.enum(["completed", "failed"]).optional(),
        })
        .passthrough()
    ),
  })
  .openapi("ReconcileHoldsResponse");

registry.registerPath({
  method: "post",
  path: "/internal/cost-holds/reconcile",
  summary: "Settle provisioned cost holds their request never closed",
  description:
    "One pass of the hold reconciler (it also runs in-process every 10 minutes). Every provisioned hold this service opened in runs-service that is still unsettled after olderThanMinutes (default 60) is decided from what the call actually did: already closed in runs-service -> recorded; the real charge already declared on the run -> cancel; verify-email with a billed verdict -> actual; email-find with a vendor-reported charge -> that charge as actual, hold cancelled; phone-reveal after 24h -> Apollo's reported credits, or cancel if Apollo never delivered; anything else -> cancel. A run still running is then closed (completed if it carries an actual charge, failed otherwise). dryRun: true writes nothing and returns every decision. Requires x-api-key = APOLLO_SERVICE_API_KEY.",
  request: {
    headers: z.object({ "x-api-key": z.string() }),
    body: {
      content: { "application/json": { schema: ReconcileHoldsRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Per-hold decisions (applied unless dryRun)",
      content: { "application/json": { schema: ReconcileHoldsResponseSchema } },
    },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorResponseSchema } } },
    401: { description: "Missing or invalid x-api-key", content: { "application/json": { schema: ErrorResponseSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

// ─── POST /internal/outcome-declarations/backfill ────────────────────────

export const OutcomeBackfillRequestSchema = z
  .object({ dryRun: z.boolean() })
  .openapi("OutcomeBackfillRequest");

const OutcomeBackfillResponseSchema = z
  .object({
    dryRun: z.boolean(),
    candidates: z.object({
      enrichment: z.number().int(),
      email_finding: z.number().int(),
      email_verification: z.number().int(),
      phone_reveal: z.number().int(),
    }),
    parked: z.number().int(),
    queue: z.object({ pending: z.number().int(), declared: z.number().int(), abandoned: z.number().int() }),
  })
  .openapi("OutcomeBackfillResponse");

registry.registerPath({
  method: "post",
  path: "/internal/outcome-declarations/backfill",
  summary: "Declare the outcomes our PAST runs produced (COST-BACKFILL-1023)",
  description:
    "Re-reads this service's own rows (verified Apollo reveals and treg/Explee finds -> email_found, final kept verifications -> email_checked consuming email_found, found phone reveals -> phone_found) and parks one declaration per past outcome on the run that paid for it. The in-process declarer resolves each person's lead in lead-service and declares through runs-service's batch backfill door (occurredAt = the run's start), so each outcome counts as declared when its run happened. A person who never became a lead of the org is abandoned (the spend rolls into the nearest declaring ancestor). Idempotent: a re-run parks nothing already parked and runs-service records nothing twice. dryRun: true only counts. Requires x-api-key = APOLLO_SERVICE_API_KEY.",
  request: {
    headers: z.object({ "x-api-key": z.string() }),
    body: { content: { "application/json": { schema: OutcomeBackfillRequestSchema } }, required: true },
  },
  responses: {
    200: { description: "Candidates per source, rows parked by this call, the backfill queue by status", content: { "application/json": { schema: OutcomeBackfillResponseSchema } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorResponseSchema } } },
    401: { description: "Missing or invalid x-api-key", content: { "application/json": { schema: ErrorResponseSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

// ─── POST /internal/support-marks/backfill ───────────────────────────────

const SupportFunctionSchema = z.enum([
  "payment_fees",
  "brand_setup",
  "copilot",
  "platform_llm",
  "staff_experiment",
  "product_feature",
  "retired_product",
]);

export const SupportMarksBackfillRequestSchema = z
  .object({
    dryRun: z.boolean(),
    runMarks: z
      .array(
        z.object({
          kind: SupportFunctionSchema,
          reason: z.string().min(1).max(2000),
          runIds: z.array(z.string().uuid()).min(1).max(5000),
        })
      )
      .max(20)
      .optional()
      .describe("Single runs of ours a task rule cannot reach (e.g. a staff probe that borrowed one of our production runs as its x-run-id), each with its support function and why. All or nothing per entry."),
  })
  .openapi("SupportMarksBackfillRequest");

const SupportMarksBackfillResponseSchema = z
  .object({
    dryRun: z.boolean(),
    steps: z.array(
      z.object({
        label: z.string().describe("task:<task> for a task rule, runIds:<i>:<kind> for an explicit list."),
        kind: SupportFunctionSchema,
        preview: z.object({
          matchedRunCount: z.number().int(),
          toMarkCount: z.number().int(),
          alreadyMarkedCount: z.number().int(),
          declaresOutcomesCount: z.number().int(),
          onOutcomeNowCount: z.number().int().nullable(),
          spend: z.object({ grossCents: z.string(), netCents: z.string() }),
          maxRuns: z.number().int(),
          tooMany: z.boolean(),
        }),
        applied: z.object({ markedCount: z.number().int(), alreadyMarkedCount: z.number().int(), declaresOutcomesCount: z.number().int().optional() }).nullable(),
      })
    ),
  })
  .openapi("SupportMarksBackfillResponse");

registry.registerPath({
  method: "post",
  path: "/internal/support-marks/backfill",
  summary: "Mark our PAST runs that produce no outcome by design as SUPPORT (COST-SUPPORT-1024)",
  description:
    "Coverage reads declared outcome spend / (ledger - support). Runs of ours that can never produce an outcome are marked SUPPORT on runs-service's owner door, naming the function: audience-companies, company-firmographics and person-role (product_feature, also marked at creation since COST-SUPPORT-1024), waterfall-enrichment and search-params-generation (retired_product), the staff probe tasks (experiment-treg-people-search, issue-249-verification, email-find-probe, linkedin-engagement-probe, staff-verify-probe: staff_experiment), plus any explicit runMarks. runs-service leaves out every run that declared an outcome. Each step is previewed then applied; dryRun: true only previews. Idempotent: a mark is final. Requires x-api-key = APOLLO_SERVICE_API_KEY.",
  request: {
    headers: z.object({ "x-api-key": z.string() }),
    body: { content: { "application/json": { schema: SupportMarksBackfillRequestSchema } }, required: true },
  },
  responses: {
    200: { description: "Each step: what runs-service matched, the spend it moves to support, what was marked", content: { "application/json": { schema: SupportMarksBackfillResponseSchema } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorResponseSchema } } },
    401: { description: "Missing or invalid x-api-key", content: { "application/json": { schema: ErrorResponseSchema } } },
    500: { description: "runs-service refused a step (its answer verbatim)", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

// ─── POST /internal/person-identity ──────────────────────────────────────

export const PersonIdentityRequestSchema = z
  .object({ email: z.string().email().max(320).describe("The person's email. The ONLY input: a name is never used to match.") })
  .openapi("PersonIdentityRequest");

const PersonIdentityResponseSchema = z
  .object({
    email: z.string().describe("The email looked up, lower-cased."),
    matched: z.boolean().describe("Apollo matched a real person (match_confidence present and not \"none\")."),
    matchConfidence: z.string().nullable().describe("Apollo's match_confidence verbatim (\"high\" | \"low\" | \"none\"). A caller that must not guess should accept only \"high\"."),
    linkedinUrl: z.string().nullable().describe("The matched person's LinkedIn profile URL, verbatim from Apollo. null when not matched or Apollo holds none."),
    apolloPersonId: z.string().nullable(),
    name: z.string().nullable(),
    cached: z.boolean().describe("true = served from cache, nothing spent."),
  })
  .openapi("PersonIdentityResponse");

registry.registerPath({
  method: "post",
  path: "/internal/person-identity",
  summary: "Who is the person behind an email (LinkedIn profile), org-less and platform-billed",
  description:
    "Apollo people/match by EMAIL only (never by name). For org-less callers (client-service resolving one of our own users' LinkedIn profiles). Spend: 1 apollo-credit when Apollo matches a real person, 0 otherwise, declared as an actual cost on an apollo-service platform run before the answer is served. Cached globally per email with the firmographics person leg (90 days matched, 30 not): a repeat call spends nothing. Requires x-api-key = APOLLO_SERVICE_API_KEY. No identity headers.",
  request: {
    headers: z.object({ "x-api-key": z.string() }),
    body: { content: { "application/json": { schema: PersonIdentityRequestSchema } }, required: true },
  },
  responses: {
    200: { description: "Match result (unmatched is an answer, not an error)", content: { "application/json": { schema: PersonIdentityResponseSchema } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorResponseSchema } } },
    401: { description: "Missing or invalid x-api-key", content: { "application/json": { schema: ErrorResponseSchema } } },
    502: { description: "Apollo, key-service or runs-service (cost declaration) failed. A paid lookup whose cost could not be declared is declared on the next call, never paid twice.", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

// ─── POST /internal/company-firmographics ────────────────────────────────

export const CompanyFirmographicsRequestSchema = z
  .object({
    domain: z.string().min(3).max(253).describe("The company's website domain (a URL is accepted and reduced to its host, `www.` dropped)."),
    email: z.string().email().optional().describe("The person's email, when known. Used only to read their role."),
    firstName: z.string().min(1).max(100).optional(),
    lastName: z.string().min(1).max(100).optional(),
  })
  .openapi("CompanyFirmographicsRequest");

const FirmographicsRangeSchema = z
  .object({
    label: z.string().describe('Display label, e.g. "51-200" or "$10M-$50M".'),
    min: z.number(),
    max: z.number().nullable().describe("null for the open-ended top bucket."),
  })
  .openapi("FirmographicsRange");

const CompanyFirmographicsResponseSchema = z
  .object({
    domain: z.string().describe("The normalized domain that was looked up."),
    company: z
      .object({
        name: z.string().nullable(),
        domain: z.string(),
        countryCode: z.string().nullable().describe("ISO 3166-1 alpha-2 of the HQ country."),
        countryName: z.string().nullable().describe("Apollo's English country name."),
        industry: z.string().nullable(),
        revenueRange: FirmographicsRangeSchema.nullable().describe("Annual revenue bucket (USD): <$1M, $1M-$10M, $10M-$50M, $50M-$100M, $100M-$500M, $500M-$1B, $1B+."),
        employeeRange: FirmographicsRangeSchema.nullable().describe("Headcount bucket: 1-10, 11-50, 51-200, 201-500, 501-1,000, 1,001-5,000, 5,001-10,000, 10,001+."),
        category: z.enum(["B2B SaaS", "B2B Agency", "B2C", "Other"]).nullable().describe("Business model, judged by Jev from Apollo's description/keywords/industry. null when there was nothing to judge or confidence < 0.5."),
        categoryConfidence: z.number().nullable(),
        apolloOrganizationId: z.string().nullable(),
        linkedinUrl: z
          .string()
          .nullable()
          .describe("The company's LinkedIn page, verbatim from Apollo's organization record (linkedin_url, e.g. http://www.linkedin.com/company/stripe). null when Apollo has none. Not validated against the domain: a caller that needs the company's OWN page checks it."),
      })
      .nullable()
      .describe("null when the domain is a free-mail provider or Apollo knows no company for it (see noCompanyReason). Every field is independently nullable."),
    noCompanyReason: z.enum(["personal_email_domain", "not_found"]).nullable(),
    person: z
      .object({ title: z.string().nullable(), seniority: z.string().nullable() })
      .nullable()
      .describe("The person's role, only when a person was given AND Apollo matched them. Never guessed."),
    personMatched: z.boolean().nullable().describe("null when no person was given (email, or first+last name)."),
    cached: z.object({ company: z.boolean().nullable(), person: z.boolean().nullable() }).describe("true = served from cache, nothing spent."),
  })
  .openapi("CompanyFirmographicsResponse");

registry.registerPath({
  method: "post",
  path: "/internal/company-firmographics",
  summary: "Company firmographics for a domain (+ a person's role), org-less and platform-billed",
  description:
    "For platform jobs with no org (distribute.you visit recap). Given a company website domain and optionally the person's email and/or first+last name, answers HQ country, industry, revenue range, headcount range, business-model category (B2B SaaS | B2B Agency | B2C | Other), and the person's role when Apollo matches them. Free-mail domains (gmail.com, outlook.com, ...) answer company null / personal_email_domain without spending. Spend: Apollo organizations/enrich (1 apollo-credit when found, 0 when not) and people/match (1 apollo-credit when matched, 0 otherwise), declared as actual costs on an apollo-service platform run; the category is one Jev choice judgment billed by chat-service on its platform tier. Cached globally per domain and per person (90 days when found, 30 when not): a repeat call spends nothing. Requires x-api-key = APOLLO_SERVICE_API_KEY. No identity headers.",
  request: {
    headers: z.object({ "x-api-key": z.string() }),
    body: { content: { "application/json": { schema: CompanyFirmographicsRequestSchema } }, required: true },
  },
  responses: {
    200: { description: "Firmographics (fields null when unknown)", content: { "application/json": { schema: CompanyFirmographicsResponseSchema } } },
    400: { description: "Validation error (bad body or not a domain)", content: { "application/json": { schema: ErrorResponseSchema } } },
    401: { description: "Missing or invalid x-api-key", content: { "application/json": { schema: ErrorResponseSchema } } },
    502: { description: "Apollo, key-service, runs-service (cost declaration) or chat-service failed. A paid lookup whose cost could not be declared is declared on the next call, never paid twice.", content: { "application/json": { schema: ErrorResponseSchema } } },
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

const SampledPersonSchema = z
  .object({
    company: z.string().nullable().openapi({ description: "Employer name." }),
    title: z.string().nullable().openapi({ description: "The person's title." }),
  })
  .openapi("SampledPerson", {
    description:
      "One sampled person. Company + title is ALL Apollo's free teaser serves — every location field is redacted to a has_* boolean, so location is never present and obtaining it would need paid enrichment.",
  });

const RefineCandidateSchema = z
  .object({
    apolloAudienceId: z.string().openapi({ description: "Persisted apollo-audience id for THIS round's filter set." }),
    round: z.number().int().openapi({ description: "1-based position in the run, in the order the rounds were explored." }),
    filters: ApolloNativeSearchFiltersSchema.openapi({ description: "The Apollo-native filter object this round proposed." }),
    count: z.number().int().openapi({ description: "Live match-count (verified-email contactable pool) for this round's filters." }),
    sample: z
      .array(SampledPersonSchema)
      .openapi({ description: "10 people drawn from RANDOM pages of this round's result set — what the set actually matched." }),
    notes: z
      .object({
        whatWorked: z.string(),
        whatToImprove: z.string(),
        nextExperiment: z.string(),
      })
      .openapi({ description: "The model's own three one-sentence notes for this round. Its memory of what it was trying — not a grade." }),
  })
  .openapi("RefineCandidate");

const SuggestFromSegmentResponseSchema = z
  .object({
    apolloAudienceId: z.string().openapi({
      description:
        "LEGACY single result — the persisted id of the largest non-empty round. Kept additively; read `candidates` instead.",
    }),
    filters: ApolloNativeSearchFiltersSchema.openapi({ description: "LEGACY single result — that round's Apollo-native filter object." }),
    count: z.number().int().openapi({ description: "LEGACY single result — that round's live match-count." }),
    degraded: z.boolean().openapi({
      description:
        "True when the model's own account of the round being returned describes it as narrow, strict or tiny. It reads the sentences the model already wrote — it is not a self-grade the model is asked for, and it is not a count threshold. Read `candidates` for the full picture.",
    }),
    stoppedReason: z
      .enum(["model_stopped", "rounds_exhausted", "deadline", "invalid_budget_exhausted", "duplicate_budget_exhausted"])
      .openapi({
        description:
          "Why the loop stopped. `deadline` means the run hit this endpoint's 210s wall-clock bound and the exploration was cut short — the candidates returned are what it had explored by then, all of them persisted. Every other value means the run finished on its own terms.",
      }),
    candidates: z.array(RefineCandidateSchema).openapi({
      description:
        "EVERY round the loop explored, in ROUND ORDER — not ranked, not sorted, not filtered. apollo-service explores Apollo's filter space and reports what each round returned; choosing which audience serves the customer is the consumer's decision. The sample rows matter as much as the counts: they are what tells Mars and Lidl from Abderhalden Drogerie.",
    }),
  })
  .openapi("SuggestFromSegmentResponse");

const AudienceResponseSchema = z
  .object({
    apolloAudienceId: z.string(),
    filters: ApolloNativeSearchFiltersSchema,
    count: z.number().int(),
    status: z.string().openapi({ description: '"confirmed" or "exhausted".' }),
    createdAt: z.string(),
    serveSource: z.enum(["apollo", "quickenrich"]).openapi({ description: "Where /search/next sources this audience's people. Default apollo." }),
    quickenrich: z
      .object({
        expressible: z.boolean(),
        reasons: z.array(z.string()).openapi({ description: "Every constraint QuickEnrich cannot enforce; empty when expressible." }),
      })
      .openapi({ description: "Can this audience be served faithfully from QuickEnrich?" }),
  })
  .openapi("AudienceResponse");

export const ServeSourceRequestSchema = z
  .object({ serveSource: z.enum(["apollo", "quickenrich"]) })
  .openapi("ServeSourceRequest");

const ServeSourceResponseSchema = z
  .object({
    apolloAudienceId: z.string(),
    serveSource: z.enum(["apollo", "quickenrich"]),
    quickenrich: z.object({ expressible: z.boolean(), reasons: z.array(z.string()) }),
  })
  .openapi("ServeSourceResponse");

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
    "Runs the agentic NL→faithful-Apollo-filters refine loop (LLM via chat-service, free Apollo dry-runs for live counts) and persists EVERY round it explored as its own apollo-audience row. Returns `candidates`: one entry per round, in round order, each with its persisted id, filters, live count, 10 random-page sample rows and the model's three notes. This service explores and reports; it does not judge, rank or sort. The legacy single-result fields are kept additively. The LLM cost is owned by chat-service; this endpoint declares no cost (dry-runs are free).",
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
  method: "patch",
  path: "/audiences/{apolloAudienceId}/serve-source",
  summary: "Switch an audience between the Apollo and the QuickEnrich serve path",
  description:
    "quickenrich: /search/next serves this audience from the FREE QuickEnrich search (people carry full name + LinkedIn + company domain, so the caller's suppression drops anybody already served before any spend), and /enrich finds their email with treg + verifies it; once QuickEnrich has nobody left, the Apollo walk serves as before. apollo (default): unchanged Apollo path. Switching ON an audience QuickEnrich cannot enforce faithfully answers 422 with every reason.",
  request: {
    headers: audienceOrgHeaders,
    params: z.object({ apolloAudienceId: z.string() }),
    body: { content: { "application/json": { schema: ServeSourceRequestSchema } }, required: true },
  },
  responses: {
    200: { description: "Switched", content: { "application/json": { schema: ServeSourceResponseSchema } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponseSchema } } },
    422: { description: "Not expressible in QuickEnrich (reasons listed)", content: { "application/json": { schema: ErrorResponseSchema } } },
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

// ─── Buying-signal audiences ────────────────────────────────────────────────

const SignalBaseSchema = z.object({
  apolloAudienceId: z.string().uuid().optional().openapi({
    description: "The ICP: an existing apollo audience of this org whose filters are kept as-is. Exactly one of apolloAudienceId / filters.",
  }),
  filters: SearchFiltersSchema.optional().openapi({
    description: "The ICP as Apollo filters, when there is no audience yet. Exactly one of apolloAudienceId / filters.",
  }),
});

const exactlyOneBase = (v: { apolloAudienceId?: string; filters?: unknown }, ctx: z.RefinementCtx) => {
  if ((v.apolloAudienceId ? 1 : 0) + (v.filters ? 1 : 0) !== 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Provide exactly one of apolloAudienceId or filters" });
  }
};

export const SignalCoverageRequestSchema = SignalBaseSchema.extend({
  windowDays: z.array(z.number().int().min(1).max(365)).min(1).max(4).optional().openapi({
    description: "Windows to count, in days. Default [30, 90]. The 30-day count is the signal's monthly volume.",
    example: [30, 90],
  }),
  jobTitles: z.array(z.string().min(1)).optional().openapi({
    description: "Roles for the hiring signal. Omit to count employers hiring for any role.",
    example: ["office manager"],
  }),
})
  .strict()
  .superRefine(exactlyOneBase)
  .openapi("SignalCoverageRequest");

const SignalCoverageResponseSchema = z
  .object({
    measuredOn: z.string().openapi({ description: "UTC day the counts were taken (YYYY-MM-DD)." }),
    baseCount: z.number().int().openapi({ description: "Verified-email people matching the ICP with no signal." }),
    signals: z.array(
      z.object({
        type: z.enum(APOLLO_BUYING_SIGNAL_TYPES),
        windowDays: z.number().int(),
        jobTitles: z.array(z.string()).nullable(),
        count: z.number().int().openapi({ description: "Verified-email people matching ICP + signal in the window." }),
        companies: z.number().int().openapi({ description: "Distinct employers of those people (a people count can hide 200 people at 2 firms)." }),
        companiesExact: z.boolean().openapi({ description: "True when every matching person was read; false = companies counted over the first 500 people (a floor)." }),
      }),
    ),
  })
  .openapi("SignalCoverageResponse");

export const CreateSignalAudienceRequestSchema = SignalBaseSchema.extend({
  brandId: z.string().optional().openapi({ description: "Brand the audience belongs to. Defaults to the base audience's brand." }),
  name: z.string().min(1).max(200).optional().openapi({ description: "Audience name (English). Defaults to the base name plus the signal." }),
  signal: z
    .object({
      type: z.enum(BUYING_SIGNAL_TYPES),
      windowDays: z.number().int().min(1).max(365),
      jobTitles: z.array(z.string().min(1)).optional(),
      competitorPages: CompetitorPagesSchema.optional().openapi({
        description: "linkedin_engagement only (required there): 1-3 competitor LinkedIn company page URLs. The base must then be inline `filters: {}`: Apollo filters cannot be enforced on LinkedIn engagers.",
      }),
    })
    .strict(),
})
  .strict()
  .superRefine(exactlyOneBase)
  .openapi("CreateSignalAudienceRequest");

const CreateSignalAudienceResponseSchema = z
  .object({
    apolloAudienceId: z.string().uuid(),
    name: z.string(),
    description: z.string(),
    filters: z.record(z.string(), z.unknown()).openapi({ description: "ICP filters plus the relative buying_signal. Store and forward verbatim to /search/next; the window keeps rolling." }),
    count: z.number().int().nullable().openapi({ description: "Size estimate: verified-email people matching ICP + signal in the current window. Free. null for linkedin_engagement (its pool is only known once the competitor posts are read, a paid step done on the first serve)." }),
    window: z.object({ from: z.string(), to: z.string() }),
  })
  .openapi("CreateSignalAudienceResponse");

registry.registerPath({
  method: "post",
  path: "/audiences/signal-coverage",
  summary: "Measure how many people a buying signal yields for an ICP (free)",
  description:
    "Counts, for one ICP, the verified-email people matching each buying signal (hiring, job_change, funding) over each window. Free Apollo teaser counts, nothing is persisted or billed. Use it before creating a signal audience.",
  request: { headers: audienceHeaders, body: { content: { "application/json": { schema: SignalCoverageRequestSchema } } } },
  responses: {
    200: { description: "Counts per signal and window", content: { "application/json": { schema: SignalCoverageResponseSchema } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "Base audience not found", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/audiences/signal",
  summary: "Create an audience = ICP + one buying signal + a recency window",
  description:
    "Persists an apollo audience whose filters are the ICP plus a RELATIVE buying_signal, and returns its size estimate (free count). Served through /search/next like any audience: each day's serve walks a cohort of the signals in the current window, then only the new ones. Leads revealed through /enrich carry `buyingSignal` (type, date, one-line fact).",
  request: { headers: audienceHeaders, body: { content: { "application/json": { schema: CreateSignalAudienceRequestSchema } } } },
  responses: {
    200: { description: "The persisted signal audience and its size", content: { "application/json": { schema: CreateSignalAudienceResponseSchema } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "Base audience not found", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

const AudiencePreviewResponseSchema = z
  .object({
    apolloAudienceId: z.string().uuid(),
    count: z.number().int().openapi({ description: "Live verified-email match count of the stored filters (not persisted)." }),
    companies: z
      .array(
        z.object({
          name: z.string().openapi({ example: "Experience Travel Group" }),
          peopleInSample: z.number().int().openapi({ description: "How many of the sampled people work there (rank hint, not headcount)." }),
        }),
      )
      .openapi({ description: "Up to 10 distinct real employers of the sampled people, in Apollo rank order. Name only: domain/industry/size/location are not obtainable for free." }),
    people: z
      .array(
        z.object({
          apolloPersonId: z.string().nullable().openapi({
            description:
              "Apollo person id from the free teaser. Pass it as `apolloPersonId` to `POST /enrich` to reveal and verify THIS person's email (billed there, not here). Null only if Apollo omits it.",
            example: "66f1c0ffee0000000000abcd",
          }),
          firstName: z.string().nullable(),
          lastNameObfuscated: z.string().nullable().openapi({ description: "As Apollo's free teaser serves it, e.g. \"Ni***s\"." }),
          title: z.string().nullable(),
          company: z.string().nullable(),
        }),
      )
      .openapi({ description: "Up to 20 real people, round-robin across employers. Never an email, phone or full name; each carries the `apolloPersonId` handle `POST /enrich` accepts." }),
  })
  .openapi("AudiencePreviewResponse");

registry.registerPath({
  method: "get",
  path: "/audiences/{apolloAudienceId}/preview",
  summary: "Free sample of real companies and people in a persisted Apollo audience",
  description:
    "One free Apollo people-search teaser call (page 1, 100 rows, zero credits) over the audience's stored filters. Returns up to 10 distinct employers and up to 20 people as the teaser serves them: first name, obfuscated last name, title, employer. No email, phone or reveal; no cost declared. Read-only: no cursor advance, no row written, count snapshot not refreshed. An audience with no match returns count 0 and empty arrays. Page 1 of Apollo's ranking, so repeat calls are stable.",
  request: {
    headers: audienceHeaders,
    params: z.object({ apolloAudienceId: z.string() }),
  },
  responses: {
    200: { description: "Sample", content: { "application/json": { schema: AudiencePreviewResponseSchema } } },
    400: { description: "Missing identity header", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "Not found (unknown id or another org's audience)", content: { "application/json": { schema: ErrorResponseSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

export const AudienceCompaniesQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).max(99).default(0).openapi({ description: "Rank of the first company to return (0-based)." }),
  limit: z.coerce.number().int().min(1).max(100).default(25).openapi({ description: "Companies in this chunk. offset+limit is capped at 100." }),
});

const CompanyPersonSchema = z.object({
  apolloPersonId: z.string().nullable().openapi({ description: "Apollo person id from the free teaser: the handle `POST /enrich` accepts to reveal + verify this person's email (billed there, not here)." }),
  firstName: z.string().nullable(),
  lastNameObfuscated: z.string().nullable().openapi({ description: "As Apollo's free teaser serves it, e.g. \"Ni***s\"." }),
  title: z.string().nullable(),
});

const AudienceCompanySchema = z.object({
  rank: z.number().int().openapi({ description: "1-based position in Apollo's rank order of the audience's people. Stable across calls." }),
  name: z.string(),
  apolloOrganizationId: z.string().nullable().openapi({ description: "Null when no Apollo organization carries exactly this name (then every firmographic is null)." }),
  domain: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  logoUrl: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  shortDescription: z.string().nullable().openapi({ description: "Apollo's company description, verbatim (may be several sentences)." }),
  industry: z.string().nullable(),
  estimatedNumEmployees: z.number().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  country: z.string().nullable(),
  foundedYear: z.number().nullable(),
  annualRevenuePrinted: z.string().nullable().openapi({ example: "67.5B" }),
  totalFundingPrinted: z.string().nullable(),
  latestFundingStage: z.string().nullable(),
  keywords: z.array(z.string()).openapi({ description: "Up to 10 of Apollo's keyword tags for the company." }),
  peopleInSample: z.number().int().openapi({ description: "People of the audience at this company among the walked teaser pages (rank hint, not headcount)." }),
  person: CompanyPersonSchema.openapi({ description: "The first-ranked person of the audience at this company. Never an email, phone or full name." }),
});

const AudienceCompaniesResponseSchema = z
  .object({
    apolloAudienceId: z.string().uuid(),
    count: z.number().int().openapi({ description: "Live verified-email match count of the audience (people, not companies)." }),
    offset: z.number().int(),
    limit: z.number().int(),
    companies: z.array(AudienceCompanySchema),
    hasMore: z.boolean().openapi({ description: "Another chunk (offset + limit) may hold companies. Always false once 100 is reached." }),
    creditsCharged: z.number().int().openapi({ description: "Apollo credits billed to the caller's org by this call (apollo-credit): 1 per company not already in the 90-day firmographics cache." }),
  })
  .openapi("AudienceCompaniesResponse");

registry.registerPath({
  method: "get",
  path: "/audiences/{apolloAudienceId}/companies",
  summary: "Up to 100 real companies reached by a persisted Apollo audience, with firmographics and one person each",
  description:
    "Distinct employers of the audience's people (the audience's full filters, person-level included), in Apollo's rank order, chunked by offset/limit (max 100 in total). Each company carries Apollo's firmographics and the first-ranked person of the audience there (first name, obfuscated last name, title, apolloPersonId). Employers and organization ids come from free Apollo calls; the full organization record costs 1 apollo-credit per company, declared on a child run of x-run-id against the caller's org (provision, authorize for platform keys, actualize, hold released) and cached globally for 90 days, so a repeat call is free. Never an email, a phone or a filter object. 402 when the org cannot afford the chunk.",
  request: {
    headers: audienceHeaders.extend({
      "x-run-id": z.string(),
      "x-audience-id": z.string().optional(),
      "x-campaign-id": z.string().optional(),
      "x-feature-slug": z.string().optional(),
    }),
    params: z.object({ apolloAudienceId: z.string() }),
    query: AudienceCompaniesQuerySchema,
  },
  responses: {
    200: { description: "Companies", content: { "application/json": { schema: AudienceCompaniesResponseSchema } } },
    400: { description: "Missing identity header (x-org-id, x-user-id, x-run-id) or bad query", content: { "application/json": { schema: ErrorResponseSchema } } },
    402: { description: "Insufficient credits", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "Not found (unknown id or another org's audience)", content: { "application/json": { schema: ErrorResponseSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

// ─── Phone reveal ────────────────────────────────────────────────────────────
// Apollo does not return phone numbers by default: the reveal is OPT-IN, billed
// separately, and ASYNCHRONOUS. Hence a route of its own (no existing caller can
// trip it) + a read that says which of the four states the reveal is in.

const phoneRevealHeaders = z.object({
  "x-org-id": z.string(),
  "x-user-id": z.string(),
  "x-run-id": z.string().openapi({ description: "Caller's run ID — parent of the phone-reveal run this cost hangs on", example: "run-abc-123" }),
  "x-brand-id": z.string().optional().openapi({ description: "Brand ID(s) — single UUID or comma-separated list" }),
  "x-campaign-id": z.string().optional().openapi({ description: "Campaign ID" }),
  "x-audience-id": z.string().optional(),
  "x-feature-slug": z.string().optional(),
  "x-workflow-slug": z.string().optional(),
});

const phoneRevealReadHeaders = z.object({
  "x-org-id": z.string(),
});

const RevealedPhoneSchema = z
  .object({
    rawNumber: z.string().nullable(),
    sanitizedNumber: z.string().nullable(),
    type: z.string().nullable().openapi({ description: 'Apollo phone type, e.g. "mobile", "work_hq".' }),
    status: z.string().nullable(),
    dncStatus: z.string().nullable().openapi({ description: "Apollo's do-not-call status for THIS number, verbatim." }),
    dncOtherInfo: z.string().nullable(),
    position: z.number().nullable(),
    confidence: z.string().nullable().openapi({ description: "Apollo's confidence in the number, when it sends one." }),
    doNotCall: z.boolean().openapi({
      description:
        "Derived from dncStatus/dialer flags: true means the number must never be dialled. Unknown DNC values are treated as true.",
    }),
  })
  .openapi("RevealedPhone");

const PhoneRevealResponseSchema = z
  .object({
    revealId: z.string().uuid(),
    apolloPersonId: z.string(),
    status: z.enum(["pending", "found", "not_found", "failed"]).openapi({
      description:
        "pending = Apollo has not delivered yet; found = a number arrived; not_found = Apollo has no number for this person (a real answer, zero credits); failed = the reveal itself failed.",
    }),
    mobilePhone: z.string().nullable().openapi({ description: "The number to connect a rep on — the mobile when Apollo returned one." }),
    dncStatus: z.string().nullable(),
    doNotCall: z.boolean(),
    phoneNumbers: z.array(RevealedPhoneSchema),
    failureReason: z.string().nullable(),
    creditsConsumed: z.number().nullable().openapi({ description: "Credits Apollo actually charged. 0 when nothing was found." }),
    requestedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    reused: z.boolean().optional().openapi({ description: "True when an earlier reveal was served instead of spending again." }),
  })
  .openapi("PhoneRevealResponse");

registry.registerPath({
  method: "post",
  path: "/people/{apolloPersonId}/phone-reveal",
  summary: "Ask Apollo to reveal this person's phone number (opt-in, billed)",
  description:
    "Opt-in phone reveal. Apollo answers WITHOUT the number and delivers it asynchronously (minutes) to this service's callback, so this returns 202 with status \"pending\"; poll the GET for the result. Declares apollo-credit with quantity 8 (the worst case) as a provisioned hold before calling; the callback actualizes it when a number arrives and CANCELS it when none does, so a fruitless reveal costs nothing. Existing enrichment endpoints are untouched and never reveal a phone.",
  request: {
    headers: phoneRevealHeaders,
    params: z.object({ apolloPersonId: z.string() }),
  },
  responses: {
    200: { description: "A number was already available (or arrived synchronously)", content: { "application/json": { schema: PhoneRevealResponseSchema } } },
    202: { description: "Reveal requested — Apollo will deliver the number to the callback", content: { "application/json": { schema: PhoneRevealResponseSchema } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorResponseSchema } } },
    402: { description: "Insufficient credits", content: { "application/json": { schema: ErrorResponseSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/people/{apolloPersonId}/phone-reveal",
  summary: "Has the revealed phone number arrived yet?",
  description:
    "Reads the latest reveal for this person. `status` distinguishes not-here-yet from Apollo-found-nothing from the-reveal-failed. 404 means no reveal was ever requested for this person.",
  request: {
    headers: phoneRevealReadHeaders,
    params: z.object({ apolloPersonId: z.string() }),
  },
  responses: {
    200: { description: "The reveal's current state", content: { "application/json": { schema: PhoneRevealResponseSchema } } },
    404: { description: "No reveal requested for this person", content: { "application/json": { schema: ErrorResponseSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

const PhoneRevealWebhookAckSchema = z
  .object({ received: z.boolean(), updated: z.number() })
  .openapi("PhoneRevealWebhookAck");

registry.registerPath({
  method: "post",
  path: "/webhook/phone-reveal",
  summary: "Apollo's asynchronous phone delivery callback",
  description:
    "Apollo POSTs a revealed phone here minutes after the reveal request. Authenticated by the ?secret query param (APOLLO_PHONE_REVEAL_WEBHOOK_SECRET). Answers 200 for any parseable body — Apollo disables a webhook that keeps failing — except when cost reconciliation could not complete, which answers 500 so Apollo redelivers.",
  request: { params: z.object({}) },
  responses: {
    200: { description: "Delivery ingested", content: { "application/json": { schema: PhoneRevealWebhookAckSchema } } },
    401: { description: "Invalid webhook secret", content: { "application/json": { schema: ErrorResponseSchema } } },
    500: { description: "Phone stored, cost reconciliation failed — Apollo should retry", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

// ─── Email finders (treg.to, Explee) ────────────────────────────────────────

const emailFindHeaders = z.object({
  "x-org-id": z.string(),
  "x-user-id": z.string(),
  "x-run-id": z.string().openapi({ description: "Caller's run ID — parent of the email-find run the cost hangs on" }),
  "x-brand-id": z.string().optional().openapi({ description: "Brand ID(s) — single UUID or comma-separated list" }),
  "x-campaign-id": z.string().optional(),
  "x-audience-id": z.string().optional(),
  "x-feature-slug": z.string().optional(),
  "x-workflow-slug": z.string().optional(),
});

const EmailFindRequestOpenApiSchema = z
  .object({
    vendor: z.enum(["treg", "explee"]),
    preset: z.enum(["basic", "premium"]).optional().openapi({
      description: "Explee only, REQUIRED for explee: basic (1.5 credits/hit, ~50%) or premium (5 credits/hit, ~78%). Must be absent for treg.",
    }),
    person: z.object({
      apolloPersonId: z.string().optional().openapi({ description: "When given, the finding is keyed on it (idempotency key = vendor + preset + this id)." }),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      domain: z.string().optional().openapi({ description: "Company domain (a URL is accepted; scheme, www. and path are stripped)." }),
      linkedinUrl: z.string().optional().openapi({ description: "treg only — an alternative to name + domain." }),
    }),
  })
  .openapi("EmailFindRequest");

const EmailFindingSchema = z
  .object({
    findingId: z.string().uuid(),
    vendor: z.enum(["treg", "explee"]),
    preset: z.string().openapi({ description: '"basic" | "premium" for explee. treg: the routing policy the finding was asked under, e.g. "routed-max-10000" ($0.01 ceiling, since 2026-09-28); "routed-max-6000" = the $0.006 era (2026-09-26..28); "routed" = before 2026-09-26. A new policy is a new question, so it is looked up once more.' }),
    personKey: z.string(),
    apolloPersonId: z.string().nullable(),
    status: z.enum(["pending", "found", "not_found", "failed"]).openapi({
      description:
        "found / not_found = the vendor answered; pending = treg's routed provider is still running (it may still charge — do NOT retry, the hold is kept); failed = the vendor call errored (not billed, retryable).",
    }),
    found: z.boolean(),
    email: z.string().nullable(),
    vendorMailboxStatus: z.string().nullable().openapi({ description: "The vendor's own mailbox-check word, verbatim (treg: verified/unverified or the child's word; explee: valid/catch_all/catch_all_valid)." }),
    mailboxStatus: z.enum(["valid", "catch_all", "invalid", "unverified", "unknown"]).nullable().openapi({
      description: "Normalised mailbox check. catch_all includes treg accept_all and Explee catch_all_valid.",
    }),
    underlyingProvider: z.string().nullable().openapi({ description: "treg: the child provider that served (X-Treg-Served-By). explee: \"explee\"." }),
    costName: z.string().openapi({ description: "treg-micro-usd (quantity = micro-USD treg reported) or explee-credit (quantity = credits Explee charged)." }),
    chargedQuantity: z.number().nullable().openapi({ description: "What the vendor reported charging, in the cost's unit. 0 on a miss; null while pending." }),
    chargedUnit: z.string().nullable(),
    failureReason: z.string().nullable(),
    rejectedEmail: z.string().nullable().openapi({
      description:
        "An address the vendor returned that is NOT a work email (a gmail/aol/yahoo… inbox, or any address from a personal-email finder). Never served as `email`; the finding is then not_found. The vendor's charge for it stands.",
    }),
    rejectionReason: z.enum(["personal_email"]).nullable(),
    requestedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
  })
  .openapi("EmailFinding");

const EmailFindResponseSchema = EmailFindingSchema.extend({
  reused: z.boolean().openapi({ description: "true = served from the stored finding; no vendor call, nothing billed." }),
  emailVerification: EmailVerificationSchema,
}).openapi("EmailFindResponse");

registry.registerPath({
  method: "post",
  path: "/email-finder/find",
  summary: "Find a person's work email with treg.to or Explee (billed, idempotent)",
  description:
    "Asks one vendor for one person's work email. Idempotent on (vendor, preset, person): a finding already found, not found or in flight is served from storage and the vendor is never called again, so a re-run never pays twice; only a failed finding (not billed) is retried. Every vendor call is recorded verbatim (email_finder_calls) and normalised into one finding (email_findings). Cost: provisions the worst case (treg: 6,000 micro-USD, also sent as X-Treg-Route-Max-Cost, with treg walking its plan cheapest first; explee: the preset's credits), authorizes it for platform keys, then posts exactly what the vendor reported as `actual` and cancels the hold. A miss costs nothing.",
  request: {
    headers: emailFindHeaders,
    body: { content: { "application/json": { schema: EmailFindRequestOpenApiSchema } } },
  },
  responses: {
    200: { description: "Found or not found (fresh or reused)", content: { "application/json": { schema: EmailFindResponseSchema } } },
    202: { description: "treg's routed provider is still running; the finding stays pending", content: { "application/json": { schema: EmailFindResponseSchema } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorResponseSchema } } },
    402: { description: "Insufficient credits", content: { "application/json": { schema: ErrorResponseSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorResponseSchema } } },
    502: { description: "The vendor answered with an error (type vendor_error). The hold is released unless the vendor may have billed (holdKept: true).", content: { "application/json": { schema: ErrorResponseSchema } } },
    503: { description: "The vendor's platform key is not in key-service (type provider_key_missing). Nothing was called or billed.", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/email-finder/findings",
  summary: "Every treg/Explee finding held for an Apollo person",
  description: "Reads stored findings only; calls no vendor.",
  request: {
    headers: z.object({ "x-org-id": z.string() }),
    query: z.object({ apolloPersonId: z.string() }),
  },
  responses: {
    200: { description: "Findings", content: { "application/json": { schema: z.object({ findings: z.array(EmailFindingSchema) }) } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

// ─── Standalone verification of addresses a caller already holds ────────────

registry.registerPath({
  method: "post",
  path: "/email-verifications",
  summary: "Verify a batch of email addresses the caller already holds (billed to the caller's org)",
  description:
    "Verdicts for up to 50 addresses, verified 10 at a time. Step 1 = ONE verdict from the cheapest verifier that ANSWERS: ContactOut (free) → BounceVerify (Apify) → TryKitt → MillionVerifier, the next asked only when one fails to answer. Step 2 = a step-1 catch_all or unknown goes to BounceBan, whose verdict decides. treg vendors are billed as treg-micro-usd at treg's own charge (BounceBan can take ~1 min). Same guarantees as the reveal paths: every call is recorded in email_verifications (bronze, raw actor row verbatim); a decisive verdict under 30 days old is reused (reused: true, nothing billed); each fresh verification is a child run of x-run-id with cost apify-bounceverify-email provisioned, authorized against the caller's org (platform key), actualized on a decisive verdict (unknown is free) and the hold cancelled. `deliverable` is true ONLY for verdict `valid`. Duplicates (case-insensitive) are verified once; results come back in first-seen order, one per distinct address. ALL OR NOTHING: if any address cannot be verified the whole call answers 502 {type: \"email_verification\"} and no verdict is returned — a retry reuses whatever was already decided.",
  request: {
    headers: emailFindHeaders,
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              emails: z.array(z.string()).min(1).max(50).openapi({ description: "1 to 50 addresses." }),
              source: z.string().optional().openapi({ description: "Caller label stored on each bronze row as `verify:<source>`." }),
              subjects: z
                .array(
                  z.object({
                    email: z.string().openapi({ description: "One of `emails` (case-insensitive)." }),
                    subjectService: z.string().openapi({ description: "The service holding the subject, e.g. transactional-email-service." }),
                    subjectId: z.string().openapi({ description: "The subject's id in that service, stable across calls (e.g. the mailing-list subscriber id)." }),
                  })
                )
                .max(50)
                .optional()
                .openapi({
                  description:
                    "Cost ledger (COST-ACCOUNTING-1023): who each address IS. When given for an address, the verification run that decides its verdict declares produced `email_checked` on THIS subject in runs-service (no lead-service lookup, no consumed email_found). Absent = the person's lead in lead-service. A REUSED verdict (reused: true) spends nothing and declares nothing: a consumer's `consumed email_checked` then resolves to this subject's earlier occurrence (standard cost on reuse). An invalid or step-1 catch_all/unknown verdict declares nothing (a loss).",
                }),
            })
            .openapi("VerifyEmailsRequest"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "One verdict per distinct address",
      content: { "application/json": { schema: z.object({ results: z.array(EmailVerificationObjectSchema) }).openapi("VerifyEmailsResponse") } },
    },
    400: { description: "Validation error (bad body, or x-org-id / x-user-id / x-run-id missing)", content: { "application/json": { schema: ErrorResponseSchema } } },
    502: {
      description: "At least one address could not be verified (verifier down, runs/billing unreachable, insufficient balance). Nothing is returned as deliverable.",
      content: { "application/json": { schema: z.object({ type: z.literal("email_verification"), source: z.string(), error: z.string() }) } },
    },
  },
});

// ─── GET /internal/email-verifications/history ───────────────────────────

export const VerificationHistoryQuerySchema = z
  .object({
    after: z
      .string()
      .regex(/^\d{1,18}$/, "after must be a cursor returned by this route (digits)")
      .optional()
      .openapi({ description: "Opaque cursor: the `nextCursor` of the previous page. Omit (or \"0\") to start from the very first verification." }),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(5000)
      .optional()
      .openapi({ description: "Rows per page, 1-5000 (default 1000)." }),
  })
  .openapi("VerificationHistoryQuery");

const VerificationHistoryRowSchema = z
  .object({
    id: z.string().uuid().openapi({ description: "Stable id of the verification (email_verifications.id)." }),
    email: z.string().openapi({ description: "The verified address, lower-cased and trimmed." }),
    verifier: z.string().openapi({ description: "The vendor of THIS call: a step-1 verifier (\"contactout\", \"bounceverify\", \"trykitt\", \"millionverifier\") or \"bounceban\" (step 2, on a step-1 catch_all/unknown)." }),
    verdict: z
      .enum(["valid", "invalid", "catch_all", "risky", "unknown"])
      .nullable()
      .openapi({ description: "This call's verdict. null = the call returned NO verdict (vendor failed, timed out, refused); never an invented one. A step-1 catch_all/unknown (or a step-1 failure) is followed, seconds later, by the next row; the BounceBan row decides a catch_all/unknown: the latest row of an address is its verdict." }),
    verifiedAt: z.string().openapi({ description: "ISO timestamp the verification was recorded." }),
    cursor: z.string().openapi({ description: "This row's position in the feed (insertion order). Resuming with after=<cursor> returns the rows after it." }),
  })
  .openapi("VerificationHistoryRow");

const VerificationHistoryResponseSchema = z
  .object({
    verifications: z.array(VerificationHistoryRowSchema),
    nextCursor: z.string().openapi({ description: "Pass as `after` on the next call. Equals the input cursor when the page is empty." }),
    hasMore: z.boolean().openapi({ description: "true = more settled rows are ready now, call again at once; false = caught up, poll later." }),
  })
  .openapi("VerificationHistoryResponse");

registry.registerPath({
  method: "get",
  path: "/internal/email-verifications/history",
  summary: "Every email verification ever made, as a resumable feed",
  description:
    "The full history of BounceVerify verifications (bronze email_verifications, every org and source, failed calls included with verdict null), in insertion order, for a consumer that mirrors it. Start without `after`, follow `nextCursor` while `hasMore`, then poll with the last cursor. No row is ever skipped: the cursor is an insertion-ordered key and a page stops before the first row recorded less than 60 seconds ago, so a row is only served once nothing can be inserted before it. Read-only, nothing billed. Requires x-api-key = APOLLO_SERVICE_API_KEY.",
  request: {
    headers: z.object({ "x-api-key": z.string() }),
    query: VerificationHistoryQuerySchema,
  },
  responses: {
    200: {
      description: "One page of the feed",
      content: { "application/json": { schema: VerificationHistoryResponseSchema } },
    },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorResponseSchema } } },
    401: { description: "Missing or invalid x-api-key", content: { "application/json": { schema: ErrorResponseSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

// ─── POST /internal/acquisition-costs ────────────────────────────────────

const ServedLeadSchema = z
  .object({
    ref: z.string().max(200).optional().openapi({ description: "Caller's own id for this serve (e.g. lead-service leads_campaigns id), echoed back." }),
    servedCampaignId: z.string().min(1).openapi({ description: "The campaign that served the lead. Acquisitions paid by a run of THIS campaign are its own spend, not reused." }),
    servedAt: z.string().datetime({ offset: true }).openapi({ description: "When the lead was served (ISO). Only acquisitions whose run started before it count." }),
    apolloPersonId: z.string().min(1).optional().openapi({ description: "Apollo person id of the lead, when known." }),
    email: z.string().min(3).optional().openapi({ description: "The served email address (matched case-insensitively)." }),
  })
  .refine((v) => !!v.apolloPersonId || !!v.email, { message: "apolloPersonId or email is required" })
  .openapi("ServedLead");

export const AcquisitionCostsRequestSchema = z
  .object({
    orgId: z.string().uuid().openapi({ description: "The org whose campaigns served the leads (internal org UUID). Used only to split spend paid by OTHER orgs." }),
    servedLeads: z.array(ServedLeadSchema).min(1).max(5000).openapi({ description: "1-5000 served leads, any mix of campaigns of this org." }),
  })
  .openapi("AcquisitionCostsRequest");

const AcquisitionSchema = z
  .object({
    kind: z.enum(["apollo_reveal", "email_find", "email_verification"]).openapi({ description: "apollo_reveal = Apollo people/match (apollo-credit); email_find = treg/Explee find; email_verification = a billed BounceVerify check." }),
    runId: z.string().openapi({ description: "runs-service run that paid it." }),
    orgId: z.string().openapi({ description: "Org that paid it." }),
    campaignId: z.string().nullable().openapi({ description: "Campaign of the paying run (null = outside any campaign)." }),
    workflowSlug: z.string().nullable(),
    paidAt: z.string().openapi({ description: "Start of the paying run (ISO)." }),
    costInUsdCents: z.string().openapi({ description: "The paying run's ACTUAL cost (descendants included), gross, in USD cents." }),
  })
  .openapi("EarlierAcquisition");

const AcquisitionCostsResponseSchema = z
  .object({
    people: z.array(
      z.object({
        ref: z.string().nullable(),
        servedCampaignId: z.string(),
        servedAt: z.string(),
        apolloPersonId: z.string().nullable(),
        email: z.string().nullable(),
        earlierAcquisitions: z.array(AcquisitionSchema).openapi({ description: "Empty = the serve reused nothing (the campaign paid for it itself, or nobody did)." }),
        earlierAcquisitionCostInUsdCents: z.string(),
      }),
    ).openapi({ description: "One entry per served lead, in request order." }),
    campaigns: z.array(
      z.object({
        campaignId: z.string(),
        servedLeads: z.number().int().openapi({ description: "Served leads sent for this campaign." }),
        reusedLeads: z.number().int().openapi({ description: "Of them, leads with at least one earlier acquisition." }),
        earlierAcquisitionCostInUsdCents: z.string().openapi({ description: "Sum of what earlier runs paid to find those leads, USD cents. Add it to the campaign's own spend to price its leads." }),
        paidByOtherOrgsCostInUsdCents: z.string().openapi({ description: "Part of that sum paid by OTHER orgs (the reveal cache is fleet-wide)." }),
      }),
    ).openapi({ description: "Totals per servedCampaignId." }),
    unpricedRunIds: z.array(z.string()).openapi({ description: "Paying runs runs-service did not return (deleted org): left OUT of every sum. Expected empty." }),
  })
  .openapi("AcquisitionCostsResponse");

registry.registerPath({
  method: "post",
  path: "/internal/acquisition-costs",
  summary: "What earlier runs paid to find the leads a campaign served",
  description:
    "A lead keeps the price paid to find it. When a campaign serves a lead that an EARLIER run already revealed (Apollo), found (treg/Explee) or verified (BounceVerify), the campaign's own runs carry no acquisition cost for it. This read returns, per served lead and totalled per campaign, the actual cost of every such earlier acquisition: paid by a run that is NOT of the serving campaign (another campaign, or none) and started before the serve. Any org's payment counts (the reveal cache is fleet-wide); the other-org part is split out. The caller says who was served (lead-service owns serves). One call for up to 5000 leads, any mix of campaigns. Read-only: nothing is billed, declared or moved; the earlier payer stays the payer. Requires x-api-key = APOLLO_SERVICE_API_KEY.",
  request: {
    headers: z.object({ "x-api-key": z.string() }),
    body: { content: { "application/json": { schema: AcquisitionCostsRequestSchema } } },
  },
  responses: {
    200: { description: "Earlier acquisitions per lead and per campaign", content: { "application/json": { schema: AcquisitionCostsResponseSchema } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorResponseSchema } } },
    401: { description: "Missing or invalid x-api-key", content: { "application/json": { schema: ErrorResponseSchema } } },
    413: { description: "Body over the 5mb limit of this route (5000 served leads is ~1.25 MB)", content: { "application/json": { schema: ErrorResponseSchema } } },
    500: { description: "Internal server error (DB or runs-service unreachable)", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});
