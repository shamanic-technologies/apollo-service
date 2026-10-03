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
    // NULL = a reveal made outside any campaign (POST /enrich without x-campaign-id).
    campaignId: text("campaign_id"),
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
    index("idx_enrichments_organization_id").on(table.organizationId),
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
    // QuickEnrich walk for the SAME filter set, used only when its audience is
    // switched to quickenrich. Its own opaque cursor; exhausted → the Apollo
    // walk above takes over.
    quickenrichCursor: text("quickenrich_cursor"),
    quickenrichPages: integer("quickenrich_pages").notNull().default(0),
    quickenrichExhausted: boolean("quickenrich_exhausted").notNull().default(false),
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

    // Where /search/next sources this audience's people: "apollo" (default,
    // Apollo teaser + Apollo reveal) or "quickenrich" (free QuickEnrich search
    // + treg email find, Apollo fallback). Per audience, OFF by default.
    serveSource: text("serve_source").notNull().default("apollo"),

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

// ─── Email finders (treg.to, Explee) ────────────────────────────────────────
//
// BRONZE: every vendor call, verbatim, append-only. One row per HTTP exchange
// (or per exchange that failed before an answer came back). Never updated.
export const emailFinderCalls = pgTable(
  "email_finder_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    findingId: uuid("finding_id").notNull(),
    vendor: text("vendor").notNull(), // "treg" | "explee"
    preset: text("preset").notNull(), // explee: "basic" | "premium"; treg: routing policy ("routed-max-10000"; "routed-max-6000" / "routed" = older ceilings)
    orgId: uuid("org_id").notNull(),
    userId: text("user_id"),
    runId: text("run_id"),
    findRunId: text("find_run_id"),
    requestUrl: text("request_url").notNull(),
    // Headers we sent (credentials redacted) — proves the ceiling/routing asked for.
    // Null on rows written before 2026-09-26.
    requestHeaders: jsonb("request_headers"),
    requestBody: jsonb("request_body").notNull(),
    httpStatus: integer("http_status"),
    responseHeaders: jsonb("response_headers"),
    // Parsed JSON when the body parses, else the raw text under { _raw }.
    responseBody: jsonb("response_body"),
    underlyingProvider: text("underlying_provider"),
    // What the vendor says it charged, in the vendor's own unit
    // (treg: integer micro-USD from X-Treg-Cost-Micro; explee: credits).
    chargedQuantity: decimal("charged_quantity", { precision: 20, scale: 6 }),
    chargedUnit: text("charged_unit"),
    error: text("error"),
    durationMs: integer("duration_ms"),
    calledAt: timestamp("called_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_email_finder_calls_finding").on(table.findingId),
    index("idx_email_finder_calls_vendor_called").on(table.vendor, table.calledAt),
  ]
);

// SILVER: one normalised finding per (vendor, preset, person). The unique key
// is what makes a re-request free: a second ask for the same person on the same
// vendor + preset is answered from this row and never re-sent to the vendor.
export const emailFindings = pgTable(
  "email_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    vendor: text("vendor").notNull(),
    preset: text("preset").notNull(),
    personKey: text("person_key").notNull(),

    // Who we asked about (as given by the caller).
    apolloPersonId: text("apollo_person_id"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    domain: text("domain"),
    linkedinUrl: text("linkedin_url"),

    // The org/run that paid for the (one) vendor call.
    orgId: uuid("org_id").notNull(),
    userId: text("user_id"),
    runId: text("run_id"),
    findRunId: text("find_run_id"),
    brandIds: text("brand_ids").array(),
    campaignId: text("campaign_id"),

    // "pending" | "found" | "not_found" | "failed"
    status: text("status").notNull().default("pending"),
    email: text("email"),
    // The vendor's own word for the mailbox check, verbatim.
    vendorMailboxStatus: text("vendor_mailbox_status"),
    // Normalised: "valid" | "catch_all" | "invalid" | "unverified" | "unknown"
    mailboxStatus: text("mailbox_status"),
    underlyingProvider: text("underlying_provider"),

    // Cost: vendor-reported charge in the vendor's unit, the catalogue name it
    // was declared under, and the runs-service cost rows.
    costName: text("cost_name").notNull(),
    chargedQuantity: decimal("charged_quantity", { precision: 20, scale: 6 }),
    chargedUnit: text("charged_unit"),
    keySource: text("key_source"),
    provisionedCostId: text("provisioned_cost_id"),
    actualCostId: text("actual_cost_id"),

    lastCallId: uuid("last_call_id"),
    failureReason: text("failure_reason"),
    // A non-WORK address the vendor returned (a gmail/aol inbox): kept for the
    // record, never served. The finding is then `not_found`.
    rejectedEmail: text("rejected_email"),
    // "personal_email"
    rejectionReason: text("rejection_reason"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_email_findings_vendor_preset_person").on(table.vendor, table.preset, table.personKey),
    index("idx_email_findings_apollo_person").on(table.apolloPersonId),
  ]
);

// ─── Pre-serve email verification (BounceVerify via Apify) ──────────────────
//
// BRONZE + the verdict: one row per verification CALL, append-only, the actor's
// raw row kept verbatim. The latest decisive verdict for an address within
// VERDICT_REUSE_DAYS is what every reveal response reuses (see
// src/lib/email-verification.ts), so the same address is not paid for twice.
export const emailVerifications = pgTable(
  "email_verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Lower-cased, trimmed.
    email: text("email").notNull(),
    verifier: text("verifier").notNull(), // "bounceverify"
    // "valid" | "invalid" | "catch_all" | "risky" | "unknown"; null when the call failed.
    verdict: text("verdict"),
    // The actor's own row for this address, verbatim.
    rawResult: jsonb("raw_result"),
    httpStatus: integer("http_status"),
    error: text("error"),
    orgId: uuid("org_id").notNull(),
    userId: text("user_id"),
    runId: text("run_id"),
    verifyRunId: text("verify_run_id"),
    // What asked: "enrich" | "match" | "email-finder:<vendor>".
    source: text("source"),
    keySource: text("key_source"),
    billed: boolean("billed").notNull().default(false),
    durationMs: integer("duration_ms"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_email_verifications_email_at").on(table.email, table.verifiedAt),
    // Domain-level lookup for the reveal domain gate (catch-all is a domain fact).
    index("idx_email_verifications_domain_at").on(sql`split_part(${table.email}, '@', 2)`, table.verifiedAt),
  ]
);

// ─── QuickEnrich (free candidate source) ────────────────────────────────────
// Bronze: every QuickEnrich search call through treg, verbatim.
export const quickenrichSearches = pgTable(
  "quickenrich_searches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    runId: text("run_id"),
    campaignId: text("campaign_id"),
    cursorId: uuid("cursor_id"),
    apolloAudienceId: uuid("apollo_audience_id"),
    requestBody: jsonb("request_body").notNull(),
    httpStatus: integer("http_status"),
    responseHeaders: jsonb("response_headers"),
    responseBody: jsonb("response_body"),
    // X-Treg-Cost-Micro. The search is free; anything else fails the call.
    chargedMicro: integer("charged_micro"),
    rowsReturned: integer("rows_returned"),
    rowsKept: integer("rows_kept"),
    error: text("error"),
    durationMs: integer("duration_ms"),
    calledAt: timestamp("called_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_quickenrich_searches_cursor").on(table.cursorId, table.calledAt)]
);

// Silver: one row per QuickEnrich person (emp_id), as last seen. /enrich reads
// the identity from here when asked for a `qe:<emp_id>` person.
export const quickenrichPeople = pgTable(
  "quickenrich_people",
  {
    empId: text("emp_id").primaryKey(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    title: text("title"),
    linkedinUrl: text("linkedin_url"),
    companyDomain: text("company_domain"),
    companyName: text("company_name"),
    locality: text("locality"),
    raw: jsonb("raw").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  }
);

// Global cache of Apollo's full organization record (GET organizations/{id},
// 1 lead credit each), keyed on the Apollo organization id. Firmographics are
// facts about a company, not about the org that asked, so there is no org_id:
// a company paid for once is served free to every later caller until it is
// ORG_CACHE_DAYS old. `raw` is the record verbatim (bronze).
export const apolloOrganizations = pgTable("apollo_organizations", {
  id: text("id").primaryKey(),
  raw: jsonb("raw").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Reveal domain gate ─────────────────────────────────────────────────────
// Who an Apollo teaser person works for. The free teaser carries the employer
// NAME only (no domain, no org id); /search/next records it here so /enrich can
// judge the employer's mail domain BEFORE paying for the reveal. A fact about
// Apollo's data, not about the org that searched: no org_id.
export const apolloTeaserPeople = pgTable("apollo_teaser_people", {
  apolloPersonId: text("apollo_person_id").primaryKey(),
  organizationName: text("organization_name").notNull(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

// Every reveal NOT bought because the person's mail domain cannot pass the
// deliverability gate (src/lib/reveal-domain-gate.ts). `evidence` names each
// domain judged, its verdict and the email_verifications row that proves it.
export const revealSkips = pgTable(
  "reveal_skips",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    runId: text("run_id").notNull(),
    brandIds: text("brand_ids").array(),
    campaignId: text("campaign_id"),
    audienceId: text("audience_id"),
    apolloPersonId: text("apollo_person_id").notNull(),
    organizationName: text("organization_name"),
    organizationId: text("organization_id"),
    // "catch_all_domain" | "checker_blocked_domain"
    reason: text("reason").notNull(),
    evidence: jsonb("evidence").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_reveal_skips_campaign").on(table.campaignId, table.createdAt),
    index("idx_reveal_skips_org").on(table.orgId),
  ]
);

// ─── Cost holds ─────────────────────────────────────────────────────────────
// Every PROVISIONED cost this service opens in runs-service, recorded the moment
// runs-service returns its id (src/lib/runs-client.ts addCosts) and settled the
// moment any path flips it to actual/cancelled (updateCostStatus). A hold still
// unsettled long after its request is one the request never closed (a crash, a
// deploy swap, a failed cleanup); src/lib/hold-reconciler.ts settles it from
// what the call actually did. Identity columns are what runs-service needs to
// PATCH the hold and the run later, with no request left to read them from.
export const costHolds = pgTable(
  "cost_holds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    costId: text("cost_id").notNull(),
    runId: text("run_id").notNull(),
    costName: text("cost_name").notNull(),
    costSource: text("cost_source").notNull(),
    quantity: decimal("quantity", { precision: 20, scale: 6 }).notNull(),
    orgId: uuid("org_id").notNull(),
    userId: text("user_id"),
    brandIds: text("brand_ids").array(),
    campaignId: text("campaign_id"),
    audienceId: text("audience_id"),
    featureSlug: text("feature_slug"),
    workflowSlug: text("workflow_slug"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // "actual" | "cancelled" — what the hold became
    settledStatus: text("settled_status"),
    // "request" (the path that opened it) | "reconciler" (src/lib/hold-reconciler.ts)
    settledBy: text("settled_by"),
    // Reconciler only: the evidence the decision rests on, in one sentence.
    settlementReason: text("settlement_reason"),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("idx_cost_holds_cost").on(table.costId),
    index("idx_cost_holds_unsettled").on(table.createdAt).where(sql`settled_at IS NULL`),
  ]
);

export type CostHold = typeof costHolds.$inferSelect;

// ─── Buying signals (src/lib/buying-signals.ts) ─────────────────────────────
// Bronze: every Apollo job-postings call verbatim (1 credit when it returns
// postings). A fact about a company, so no org_id: the billed org is on the run.
export const apolloJobPostingsFetches = pgTable(
  "apollo_job_postings_fetches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    apolloOrganizationId: text("apollo_organization_id").notNull(),
    runId: text("run_id").notNull(),
    postingsCount: integer("postings_count").notNull(),
    responseBody: jsonb("response_body").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_job_postings_fetches_org").on(table.apolloOrganizationId, table.fetchedAt)]
);

// Silver: one canonical buying signal per (type, source, source_ref): a dated,
// sourced fact about a company (hiring, funding) or a person (job_change).
// Global like apollo_organizations: a signal is a fact, not org data.
export const buyingSignals = pgTable(
  "buying_signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    signalType: text("signal_type").notNull(), // hiring | job_change | funding
    apolloOrganizationId: text("apollo_organization_id"),
    apolloPersonId: text("apollo_person_id"),
    occurredOn: text("occurred_on").notNull(), // YYYY-MM-DD
    fact: text("fact").notNull(),
    source: text("source").notNull(), // apollo:job_postings | apollo:enrichment
    sourceRef: text("source_ref").notNull(),
    sourceUrl: text("source_url"),
    detail: jsonb("detail"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_buying_signals_source").on(table.signalType, table.source, table.sourceRef),
    index("idx_buying_signals_org").on(table.apolloOrganizationId, table.signalType),
    index("idx_buying_signals_person").on(table.apolloPersonId, table.signalType),
  ]
);

// Gold: which buying-signal cohort served a teaser person to a campaign, so
// /enrich knows which signal to attach (and which evidence to buy). Org data.
export const apolloSignalServes = pgTable(
  "apollo_signal_serves",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandIds: text("brand_ids").array().notNull(),
    campaignId: text("campaign_id").notNull(),
    cursorId: uuid("cursor_id").notNull(),
    apolloPersonId: text("apollo_person_id").notNull(),
    signal: jsonb("signal").notNull(),
    servedAt: timestamp("served_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_signal_serves_org_campaign_person").on(table.orgId, table.campaignId, table.apolloPersonId),
    index("idx_signal_serves_org_person").on(table.orgId, table.apolloPersonId),
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
export type EmailFinderCall = typeof emailFinderCalls.$inferSelect;
export type EmailFinding = typeof emailFindings.$inferSelect;
export type EmailVerification = typeof emailVerifications.$inferSelect;

// ─── linkedin_engagement buying signal (src/lib/linkedin-engagement.ts) ─────
// Bronze: every treg call the signal makes (company posts, post engagement,
// member profile), verbatim with its charge. Global facts about LinkedIn, no
// org: the payer is the run (`run_id`) the cost was declared on.
export const linkedinTregCalls = pgTable(
  "linkedin_treg_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    endpoint: text("endpoint").notNull(),
    request: jsonb("request").notNull(),
    runId: text("run_id"),
    httpStatus: integer("http_status"),
    responseHeaders: jsonb("response_headers"),
    responseBody: jsonb("response_body"),
    chargedMicro: integer("charged_micro"),
    error: text("error"),
    durationMs: integer("duration_ms"),
    calledAt: timestamp("called_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_linkedin_treg_calls_endpoint").on(table.endpoint, table.calledAt)]
);

// Silver: a competitor company page and when its recent posts were last listed.
export const linkedinCompanyPages = pgTable("linkedin_company_pages", {
  slug: text("slug").primaryKey(),
  url: text("url").notNull(),
  postsFetchedAt: timestamp("posts_fetched_at", { withTimezone: true }),
  postsCount: integer("posts_count"),
});

// Silver: one post of a company page. `published_at` is APPROXIMATE (LinkedIn
// gives a relative age). `engagement_fetched_at` = engagers last read.
export const linkedinCompanyPosts = pgTable(
  "linkedin_company_posts",
  {
    postId: text("post_id").primaryKey(),
    pageSlug: text("page_slug").notNull(),
    postUrl: text("post_url"),
    text: text("text"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    engagementFetchedAt: timestamp("engagement_fetched_at", { withTimezone: true }),
    reactionsSeen: integer("reactions_seen"),
    commentsSeen: integer("comments_seen"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_linkedin_posts_page").on(table.pageSlug, table.publishedAt)]
);

// Silver: one person's engagement with one post (a reaction type, or a comment).
export const linkedinPostEngagements = pgTable(
  "linkedin_post_engagements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postId: text("post_id").notNull(),
    pageSlug: text("page_slug").notNull(),
    profileId: text("profile_id").notNull(),
    kind: text("kind").notNull(),
    ref: text("ref").notNull(),
    actorName: text("actor_name"),
    actorHeadline: text("actor_headline"),
    actorProfileUrl: text("actor_profile_url"),
    reactionType: text("reaction_type"),
    commentText: text("comment_text"),
    commentedAt: timestamp("commented_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_linkedin_engagements_unique").on(table.postId, table.profileId, table.kind, table.ref),
    index("idx_linkedin_engagements_page_profile").on(table.pageSlug, table.profileId),
  ]
);

// Silver: a member profile resolved from its id (public slug, current
// employer, company website). `status` not_found = no provider could read it.
export const linkedinProfiles = pgTable("linkedin_profiles", {
  profileId: text("profile_id").primaryKey(),
  status: text("status").notNull(),
  publicIdentifier: text("public_identifier"),
  linkedinUrl: text("linkedin_url"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  headline: text("headline"),
  jobTitle: text("job_title"),
  companyName: text("company_name"),
  companySlug: text("company_slug"),
  companyLinkedinUrl: text("company_linkedin_url"),
  companyWebsite: text("company_website"),
  country: text("country"),
  location: text("location"),
  raw: jsonb("raw"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

// Gold, org data: every engager an audience has considered, ONCE per
// (org, audience, person) — the unique index is the atomic never-twice
// guarantee. status served | excluded (competitor employee) | unresolvable.
export const linkedinEngagementServes = pgTable(
  "linkedin_engagement_serves",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandIds: text("brand_ids").array().notNull(),
    campaignId: text("campaign_id").notNull(),
    audienceKey: text("audience_key").notNull(),
    profileId: text("profile_id").notNull(),
    status: text("status").notNull(),
    reason: text("reason"),
    signal: jsonb("signal").notNull(),
    servedAt: timestamp("served_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_linkedin_serves_org_audience_profile").on(table.orgId, table.audienceKey, table.profileId),
    index("idx_linkedin_serves_org_profile").on(table.orgId, table.profileId),
  ]
);
