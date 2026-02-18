import { pgTable, uuid, text, timestamp, uniqueIndex, index, integer, decimal, jsonb, boolean } from "drizzle-orm/pg-core";

// Local users table (maps to Clerk)
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clerkUserId: text("clerk_user_id").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_users_clerk_id").on(table.clerkUserId),
  ]
);

// Local orgs table (maps to Clerk)
export const orgs = pgTable(
  "orgs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clerkOrgId: text("clerk_org_id").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_orgs_clerk_id").on(table.clerkOrgId),
  ]
);

// Apollo people search results
export const apolloPeopleSearches = pgTable(
  "apollo_people_searches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(), // Reference to runs-service run ID

    // Hierarchy IDs
    appId: text("app_id").notNull(),
    brandId: text("brand_id").notNull(),
    campaignId: text("campaign_id").notNull(),

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
    index("idx_searches_campaign").on(table.campaignId),
  ]
);

// Apollo people enrichments (individual lead data)
export const apolloPeopleEnrichments = pgTable(
  "apollo_people_enrichments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    searchId: uuid("search_id")
      .references(() => apolloPeopleSearches.id, { onDelete: "cascade" }),

    // Hierarchy IDs
    appId: text("app_id").notNull(),
    brandId: text("brand_id").notNull(),
    campaignId: text("campaign_id").notNull(),

    // Apollo person ID
    apolloPersonId: text("apollo_person_id"),

    // Person fields
    firstName: text("first_name"),
    lastName: text("last_name"),
    email: text("email"),
    emailStatus: text("email_status"),
    title: text("title"),
    linkedinUrl: text("linkedin_url"),
    photoUrl: text("photo_url"),
    headline: text("headline"),
    city: text("city"),
    state: text("state"),
    country: text("country"),
    seniority: text("seniority"),
    departments: jsonb("departments"),
    subdepartments: jsonb("subdepartments"),
    functions: jsonb("functions"),
    twitterUrl: text("twitter_url"),
    githubUrl: text("github_url"),
    facebookUrl: text("facebook_url"),
    employmentHistory: jsonb("employment_history"),

    // Organization fields
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

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_enrichments_org").on(table.orgId),
    index("idx_enrichments_run").on(table.runId),
    index("idx_enrichments_email").on(table.email),
    index("idx_enrichments_person_id").on(table.apolloPersonId),
    index("idx_enrichments_campaign").on(table.campaignId),
  ]
);

// Search pagination cursors (one per campaign per org)
export const apolloSearchCursors = pgTable(
  "apollo_search_cursors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    campaignId: text("campaign_id").notNull(),
    appId: text("app_id").notNull(),
    brandId: text("brand_id").notNull(),
    searchParams: jsonb("search_params").notNull(),
    currentPage: integer("current_page").notNull().default(1),
    totalEntries: integer("total_entries").notNull().default(0),
    exhausted: boolean("exhausted").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_cursors_org_campaign").on(table.orgId, table.campaignId),
    index("idx_cursors_campaign").on(table.campaignId),
  ]
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Org = typeof orgs.$inferSelect;
export type NewOrg = typeof orgs.$inferInsert;
export type ApolloPeopleSearch = typeof apolloPeopleSearches.$inferSelect;
export type NewApolloPeopleSearch = typeof apolloPeopleSearches.$inferInsert;
export type ApolloPeopleEnrichment = typeof apolloPeopleEnrichments.$inferSelect;
export type NewApolloPeopleEnrichment = typeof apolloPeopleEnrichments.$inferInsert;
export type ApolloSearchCursor = typeof apolloSearchCursors.$inferSelect;
export type NewApolloSearchCursor = typeof apolloSearchCursors.$inferInsert;
