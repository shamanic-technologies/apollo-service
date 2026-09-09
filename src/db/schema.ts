import { pgTable, uuid, text, timestamp, uniqueIndex, index, integer, decimal, jsonb, boolean } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Apollo people search results
export const apolloPeopleSearches = pgTable(
  "apollo_people_searches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    runId: text("run_id").notNull(), // Reference to runs-service run ID

    // Hierarchy IDs
    brandIds: text("brand_ids").array().notNull(),
    campaignId: text("campaign_id").notNull(),
    audienceId: text("audience_id"),
    featureSlug: text("feature_slug"),
    workflowSlug: text("workflow_slug"),

    // Request params (for debugging/replay)
    requestParams: jsonb("request_params"),

    // Results summary
    peopleCount: integer("people_count").notNull().default(0),
    totalEntries: integer("total_entries").notNull().default(0),

    // Raw response (for debugging)
    responseRaw: jsonb("response_raw"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_searches_org").on(table.orgId),
    index("idx_searches_run").on(table.runId),
    index("idx_searches_brand_ids").using("gin", table.brandIds),
    index("idx_searches_campaign").on(table.campaignId),
    index("idx_searches_audience").on(table.audienceId),
    index("idx_searches_feature_slug").on(table.featureSlug),
  ]
);

// Apollo people enrichments (individual lead data)
export const apolloPeopleEnrichments = pgTable(
  "apollo_people_enrichments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    runId: text("run_id").notNull(),
    searchId: uuid("search_id")
      .references(() => apolloPeopleSearches.id, { onDelete: "cascade" }),

    // Hierarchy IDs
    brandIds: text("brand_ids").array().notNull(),
    campaignId: text("campaign_id").notNull(),
    audienceId: text("audience_id"),
    featureSlug: text("feature_slug"),
    workflowSlug: text("workflow_slug"),

    // Apollo person ID
    apolloPersonId: text("apollo_person_id"),

    // Person fields
    firstName: text("first_name"),
    lastName: text("last_name"),
    name: text("name"),
    email: text("email"),
    emailStatus: text("email_status"),
    title: text("title"),
    linkedinUrl: text("linkedin_url"),
    photoUrl: text("photo_url"),
    headline: text("headline"),
    city: text("city"),
    state: text("state"),
    country: text("country"),
    // Recipient IANA timezone (e.g. "America/New_York") for local-time send.
    timeZone: text("time_zone"),
    seniority: text("seniority"),
    departments: jsonb("departments"),
    subdepartments: jsonb("subdepartments"),
    functions: jsonb("functions"),
    twitterUrl: text("twitter_url"),
    githubUrl: text("github_url"),
    facebookUrl: text("facebook_url"),
    personalEmails: jsonb("personal_emails"),
    mobilePhone: text("mobile_phone"),
    phoneNumbers: jsonb("phone_numbers"),
    employmentHistory: jsonb("employment_history"),

    // Organization fields
    organizationId: text("organization_id"),
    organizationName: text("organization_name"),
    organizationDomain: text("organization_domain"),
    organizationIndustry: text("organization_industry"),
    organizationSize: text("organization_size"),
    organizationRevenueUsd: decimal("organization_revenue_usd", { precision: 15, scale: 2 }),
    organizationWebsiteUrl: text("organization_website_url"),
    organizationLogoUrl: text("organization_logo_url"),
    organizationShortDescription: text("organization_short_description"),
    organizationSeoDescription: text("organization_seo_description"),
    organizationLinkedinUrl: text("organization_linkedin_url"),
    organizationTwitterUrl: text("organization_twitter_url"),
    organizationFacebookUrl: text("organization_facebook_url"),
    organizationBlogUrl: text("organization_blog_url"),
    organizationCrunchbaseUrl: text("organization_crunchbase_url"),
    organizationAngellistUrl: text("organization_angellist_url"),
    organizationFoundedYear: integer("organization_founded_year"),
    organizationPrimaryPhone: text("organization_primary_phone"),
    organizationPubliclyTradedSymbol: text("organization_publicly_traded_symbol"),
    organizationPubliclyTradedExchange: text("organization_publicly_traded_exchange"),
    organizationAnnualRevenuePrinted: text("organization_annual_revenue_printed"),
    organizationTotalFunding: decimal("organization_total_funding", { precision: 15, scale: 2 }),
    organizationTotalFundingPrinted: text("organization_total_funding_printed"),
    organizationLatestFundingRoundDate: text("organization_latest_funding_round_date"),
    organizationLatestFundingStage: text("organization_latest_funding_stage"),
    organizationFundingEvents: jsonb("organization_funding_events"),
    organizationCity: text("organization_city"),
    organizationState: text("organization_state"),
    organizationCountry: text("organization_country"),
    organizationStreetAddress: text("organization_street_address"),
    organizationPostalCode: text("organization_postal_code"),
    organizationRawAddress: text("organization_raw_address"),
    organizationTechnologyNames: jsonb("organization_technology_names"),
    organizationCurrentTechnologies: jsonb("organization_current_technologies"),
    organizationKeywords: jsonb("organization_keywords"),
    organizationIndustries: jsonb("organization_industries"),
    organizationSecondaryIndustries: jsonb("organization_secondary_industries"),
    organizationNumSuborganizations: integer("organization_num_suborganizations"),
    organizationRetailLocationCount: integer("organization_retail_location_count"),
    organizationAlexaRanking: integer("organization_alexa_ranking"),

    // Raw response
    responseRaw: jsonb("response_raw"),

    // Link to runs-service enrichment run for cost tracking
    enrichmentRunId: text("enrichment_run_id"),

    // Waterfall enrichment tracking
    waterfallRequestId: text("waterfall_request_id"),
    waterfallStatus: text("waterfall_status"), // "pending" | "completed" | "failed" | null
    waterfallSource: text("waterfall_source"), // vendor name that found the email
    keySource: text("key_source"), // "platform" | "org" — needed for deferred cost tracking
    provisionedCostId: text("provisioned_cost_id"), // runs-service cost ID for provisioned waterfall cost

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_enrichments_org").on(table.orgId),
    index("idx_enrichments_run").on(table.runId),
    index("idx_enrichments_brand_ids").using("gin", table.brandIds),
    index("idx_enrichments_email").on(table.email),
    index("idx_enrichments_person_id").on(table.apolloPersonId),
    index("idx_enrichments_campaign").on(table.campaignId),
    index("idx_enrichments_audience").on(table.audienceId),
    index("idx_enrichments_feature_slug").on(table.featureSlug),
    index("idx_enrichments_waterfall_req").on(table.waterfallRequestId),
  ]
);

// Search pagination cursors (one per campaign per org)
export const apolloSearchCursors = pgTable(
  "apollo_search_cursors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    campaignId: text("campaign_id").notNull(),
    audienceId: text("audience_id"),
    brandIds: text("brand_ids").array().notNull(),
    featureSlug: text("feature_slug"),
    workflowSlug: text("workflow_slug"),
    searchParams: jsonb("search_params").notNull(),
    // Deterministic hash of searchParams (DB-computed so it always matches
    // Postgres' canonical jsonb serialization). Backs the per-filter-set unique
    // index so each distinct filter set for a campaign gets its OWN cursor
    // instead of evicting the others to page 1.
    paramsHash: text("params_hash").generatedAlwaysAs(sql`md5(search_params::text)`),
    currentPage: integer("current_page").notNull().default(1),
    totalEntries: integer("total_entries").notNull().default(0),
    exhausted: boolean("exhausted").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_cursors_org_campaign_params").on(table.orgId, table.campaignId, table.paramsHash),
    index("idx_cursors_campaign").on(table.campaignId),
  ]
);

// ─── Apollo audiences ────────────────────────────────────────────────────────
// A saved, faithful Apollo People-Search filter set ("an Apollo audience"),
// owned by apollo-service. human-service stores only `id` (a pointer) and never
// holds Apollo's filter vocabulary.
//
// Layering (single-table, layered columns):
//   bronze → `refineTrace` (raw refine iterations: every tested filter set +
//            its live Apollo count + the model's decision)
//   silver → `filters` (the canonical, faithful Apollo filter object) keyed by id
//   gold   → `count` (the confirmed match-count snapshot) + `countRefreshedAt`
export const apolloAudiences = pgTable(
  "apollo_audiences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    userId: text("user_id"),
    brandId: text("brand_id"),

    name: text("name").notNull(),
    description: text("description").notNull(),

    // Silver: the canonical faithful Apollo filter object (public camelCase
    // SearchFilters shape — the one vocabulary).
    filters: jsonb("filters").notNull(),

    // Gold: confirmed match-count snapshot + when it was last refreshed.
    count: integer("count").notNull().default(0),
    countRefreshedAt: timestamp("count_refreshed_at", { withTimezone: true }).notNull().defaultNow(),

    // Bronze: the agentic refine loop's raw trace (filter sets tried, counts,
    // decisions). Audit/replay only — never read on the hot path.
    refineTrace: jsonb("refine_trace"),

    status: text("status").notNull().default("confirmed"), // "confirmed" | "exhausted"

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_audiences_org").on(table.orgId),
    index("idx_audiences_brand").on(table.brandId),
  ]
);

// ─── Apollo phone reveals ────────────────────────────────────────────────────
// Apollo does NOT return phone numbers by default: a reveal is opt-in, charged
// separately (~8 credits, and ZERO when nothing is found), and ASYNCHRONOUS —
// Apollo answers the enrichment call immediately WITHOUT the number, then POSTs
// the phone to a callback URL minutes later. This table is the reveal's whole
// lifecycle: one row per (org, apollo person) reveal request.
//
// Layering:
//   bronze → `webhookPayload` (Apollo's raw callback body, verbatim)
//   silver → `phoneNumbers` (Apollo's phone objects, incl. per-number dnc)
//   gold   → `status` + `mobilePhone` + `dncStatus` (what a consumer reads)
//
// `status` is the whole point of the table for the consumer: it distinguishes
// "not here yet" (pending) from "Apollo found nothing" (not_found) from "the
// reveal failed" (failed) — three states a null phone column cannot express.
export const apolloPhoneReveals = pgTable(
  "apollo_phone_reveals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    userId: text("user_id"),

    // Who we asked Apollo about.
    apolloPersonId: text("apollo_person_id").notNull(),

    // Inbound caller run + the child run this reveal's cost hangs on.
    runId: text("run_id"),
    revealRunId: text("reveal_run_id"),

    // Hierarchy IDs (same tracking dimensions as every other table here).
    brandIds: text("brand_ids").array(),
    campaignId: text("campaign_id"),
    audienceId: text("audience_id"),
    featureSlug: text("feature_slug"),
    workflowSlug: text("workflow_slug"),

    // Apollo's request_id from the synchronous response — the join key the
    // async callback carries back.
    apolloRequestId: text("apollo_request_id"),

    // "pending" | "found" | "not_found" | "failed"
    status: text("status").notNull().default("pending"),

    // Gold: the number a rep would be connected on, and its DNC flag.
    mobilePhone: text("mobile_phone"),
    dncStatus: text("dnc_status"),
    // Silver: every phone Apollo returned, each with its own dnc status.
    phoneNumbers: jsonb("phone_numbers"),

    // Bronze: Apollo's raw callback body.
    webhookPayload: jsonb("webhook_payload"),

    failureReason: text("failure_reason"),

    // Cost accounting: the pre-call hold, what Apollo says it charged, and when
    // the hold was reconciled (actualized or cancelled). NULL `costReconciledAt`
    // on a terminal row means the reconcile still owes — the callback retries it.
    keySource: text("key_source"),
    provisionedCostId: text("provisioned_cost_id"),
    creditsConsumed: integer("credits_consumed"),
    costReconciledAt: timestamp("cost_reconciled_at", { withTimezone: true }),

    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_phone_reveals_org_person").on(table.orgId, table.apolloPersonId),
    index("idx_phone_reveals_request").on(table.apolloRequestId),
    index("idx_phone_reveals_status").on(table.status),
  ]
);

export type ApolloPeopleSearch = typeof apolloPeopleSearches.$inferSelect;
export type NewApolloPeopleSearch = typeof apolloPeopleSearches.$inferInsert;
export type ApolloPeopleEnrichment = typeof apolloPeopleEnrichments.$inferSelect;
export type NewApolloPeopleEnrichment = typeof apolloPeopleEnrichments.$inferInsert;
export type ApolloSearchCursor = typeof apolloSearchCursors.$inferSelect;
export type NewApolloSearchCursor = typeof apolloSearchCursors.$inferInsert;
export type ApolloAudience = typeof apolloAudiences.$inferSelect;
export type NewApolloAudience = typeof apolloAudiences.$inferInsert;
export type ApolloPhoneReveal = typeof apolloPhoneReveals.$inferSelect;
export type NewApolloPhoneReveal = typeof apolloPhoneReveals.$inferInsert;
