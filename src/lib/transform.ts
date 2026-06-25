import type { ApolloPerson, ApolloSearchParams } from "./apollo-client.js";
import type { ApolloPeopleEnrichment } from "../db/schema.js";

/**
 * Legacy compatibility for the old `revenueRange` string-array alias. Apollo's
 * people-search `revenue_range` is a single `{min, max}` integer object, not an
 * array of "min,max" strings. Collapse multiple legacy ranges into one span.
 */
export function toApolloRevenueRange(
  raw: unknown,
): { min?: number; max?: number } | undefined {
  if (raw == null) return undefined;

  const finalize = (min?: number, max?: number) => {
    const out: { min?: number; max?: number } = {};
    if (min !== undefined) out.min = min;
    if (max !== undefined) out.max = max;
    return out.min === undefined && out.max === undefined ? undefined : out;
  };

  // Already an object — coerce its bounds to finite numbers.
  if (!Array.isArray(raw) && typeof raw === "object") {
    const o = raw as { min?: unknown; max?: unknown };
    const min = Number(o.min);
    const max = Number(o.max);
    return finalize(
      Number.isFinite(min) ? min : undefined,
      Number.isFinite(max) ? max : undefined,
    );
  }

  const entries = Array.isArray(raw) ? raw : [raw];
  const mins: number[] = [];
  const maxs: number[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const [minStr, maxStr] = entry.split(",");
    const min = Number(minStr?.trim());
    const max = Number(maxStr?.trim());
    if (minStr?.trim() && Number.isFinite(min)) mins.push(min);
    if (maxStr?.trim() && Number.isFinite(max)) maxs.push(max);
  }
  return finalize(
    mins.length ? Math.min(...mins) : undefined,
    maxs.length ? Math.max(...maxs) : undefined,
  );
}

/**
 * Clean a `{min, max}` range object: keep only the bounds that are present
 * (not null/undefined), drop the key entirely when empty. Works for both
 * integer ranges and ISO-date ranges — Apollo accepts either as `{min, max}`.
 */
function cleanRange<T extends number | string>(
  raw: unknown,
): { min?: T; max?: T } | undefined {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as { min?: unknown; max?: unknown };
  const out: { min?: T; max?: T } = {};
  if (o.min !== undefined && o.min !== null) out.min = o.min as T;
  if (o.max !== undefined && o.max !== null) out.max = o.max as T;
  return out.min === undefined && out.max === undefined ? undefined : out;
}

/**
 * Map search filter params to Apollo's snake_case API format. New callers use
 * Apollo-native names; legacy camelCase aliases are accepted only as a
 * transition shim and are not shown in /search/filters-prompt.
 */
export function toApolloSearchParams(sp: Record<string, unknown>): ApolloSearchParams {
  const pick = <T>(native: string, legacy?: string): T | undefined =>
    (sp[native] ?? (legacy ? sp[legacy] : undefined)) as T | undefined;

  const revenueNative =
    cleanRange<number>(sp.revenue_range) ??
    cleanRange<number>(sp.revenueRangeNative);

  return {
    person_titles: pick<string[]>("person_titles", "personTitles"),
    q_organization_keyword_tags: sp.q_organization_keyword_tags as string[] | undefined,
    organization_locations: pick<string[]>("organization_locations", "organizationLocations"),
    organization_num_employees_ranges: pick<string[]>("organization_num_employees_ranges", "organizationNumEmployeesRanges"),
    q_organization_industry_tag_ids: sp.q_organization_industry_tag_ids as string[] | undefined,
    q_keywords: pick<string>("q_keywords", "qKeywords"),
    person_locations: pick<string[]>("person_locations", "personLocations"),
    person_seniorities: pick<string[]>("person_seniorities", "personSeniorities"),
    contact_email_status: pick<string[]>("contact_email_status", "contactEmailStatus"),
    q_organization_domains: sp.q_organization_domains as string[] | undefined,
    currently_using_any_of_technology_uids: pick<string[]>("currently_using_any_of_technology_uids", "currentlyUsingAnyOfTechnologyUids"),
    revenue_range: revenueNative ?? toApolloRevenueRange(sp.revenueRange),
    organization_ids: pick<string[]>("organization_ids", "organizationIds"),
    include_similar_titles: pick<boolean>("include_similar_titles", "includeSimilarTitles"),
    q_organization_job_titles: pick<string[]>("q_organization_job_titles", "qOrganizationJobTitles"),
    person_linkedin_urls: pick<string[]>("person_linkedin_urls", "personLinkedinUrls"),
    currently_using_all_of_technology_uids: pick<string[]>("currently_using_all_of_technology_uids", "currentlyUsingAllOfTechnologyUids"),
    currently_not_using_any_of_technology_uids: pick<string[]>("currently_not_using_any_of_technology_uids", "currentlyNotUsingAnyOfTechnologyUids"),
    q_organization_domains_list: pick<string[]>("q_organization_domains_list", "qOrganizationDomainsList") ?? (sp.qOrganizationDomains as string[] | undefined),
    market_segments: pick<string[]>("market_segments", "marketSegments"),
    organization_naics_codes: pick<string[]>("organization_naics_codes", "organizationNaicsCodes"),
    not_organization_naics_codes: pick<string[]>("not_organization_naics_codes", "notOrganizationNaicsCodes"),
    organization_sic_codes: pick<string[]>("organization_sic_codes", "organizationSicCodes"),
    not_organization_sic_codes: pick<string[]>("not_organization_sic_codes", "notOrganizationSicCodes"),
    organization_job_locations: pick<string[]>("organization_job_locations", "organizationJobLocations"),
    organization_founded_year_range: cleanRange<number>(sp.organization_founded_year_range) ?? cleanRange<number>(sp.organizationFoundedYearRange),
    organization_include_unknown_founded_year: pick<boolean>("organization_include_unknown_founded_year", "organizationIncludeUnknownFoundedYear"),
    organization_headcount_growth_past_n_months: pick<number>("organization_headcount_growth_past_n_months", "organizationHeadcountGrowthPastNMonths"),
    organization_headcount_growth_range: cleanRange<number>(sp.organization_headcount_growth_range) ?? cleanRange<number>(sp.organizationHeadcountGrowthRange),
    organization_num_jobs_range: cleanRange<number>(sp.organization_num_jobs_range) ?? cleanRange<number>(sp.organizationNumJobsRange),
    organization_job_posted_at_range: cleanRange<string>(sp.organization_job_posted_at_range) ?? cleanRange<string>(sp.organizationJobPostedAtRange),
    person_total_yoe_range: cleanRange<number>(sp.person_total_yoe_range) ?? cleanRange<number>(sp.personTotalYoeRange),
    person_days_in_current_title_range: cleanRange<number>(sp.person_days_in_current_title_range) ?? cleanRange<number>(sp.personDaysInCurrentTitleRange),
    // ── UNDOCUMENTED-but-verified org-funding filters (honored by People Search) ──
    total_funding_range: cleanRange<number>(sp.total_funding_range) ?? cleanRange<number>(sp.totalFundingRange),
    latest_funding_amount_range: cleanRange<number>(sp.latest_funding_amount_range) ?? cleanRange<number>(sp.latestFundingAmountRange),
    latest_funding_date_range: cleanRange<string>(sp.latest_funding_date_range) ?? cleanRange<string>(sp.latestFundingDateRange),
    organization_latest_funding_stage_cd: pick<string[]>("organization_latest_funding_stage_cd", "organizationLatestFundingStageCd"),
  };
}

/**
 * Transform an Apollo API person to our camelCase API response format.
 * Used by POST /search and POST /enrich responses.
 */
export function transformApolloPerson(person: ApolloPerson) {
  const org = person.organization;
  return {
    id: person.id,
    firstName: person.first_name,
    lastName: person.last_name,
    name: person.name,
    email: person.email ?? null,
    emailStatus: person.email_status ?? null,
    title: person.title,
    linkedinUrl: person.linkedin_url,
    // Person profile
    photoUrl: person.photo_url,
    headline: person.headline,
    city: person.city,
    state: person.state,
    country: person.country,
    seniority: person.seniority,
    departments: person.departments,
    subdepartments: person.subdepartments,
    functions: person.functions,
    twitterUrl: person.twitter_url,
    githubUrl: person.github_url,
    facebookUrl: person.facebook_url,
    // Contact details
    personalEmails: person.personal_emails,
    mobilePhone: person.mobile_phone,
    phoneNumbers: person.phone_numbers?.map((p) => ({
      rawNumber: p.raw_number,
      sanitizedNumber: p.sanitized_number,
      type: p.type,
      position: p.position,
      status: p.status,
      dncStatus: p.dnc_status,
      dncOtherInfo: p.dnc_other_info,
      dialerFlags: p.dialer_flags,
    })),
    employmentHistory: person.employment_history?.map((eh) => ({
      title: eh.title,
      organizationName: eh.organization_name,
      startDate: eh.start_date,
      endDate: eh.end_date,
      description: eh.description,
      current: eh.current,
    })),
    // Organization
    organizationId: org?.id,
    organizationName: org?.name,
    organizationDomain: org?.primary_domain,
    organizationIndustry: org?.industry,
    organizationSize: org?.estimated_num_employees?.toString(),
    organizationRevenueUsd: org?.annual_revenue?.toString(),
    organizationWebsiteUrl: org?.website_url,
    organizationLogoUrl: org?.logo_url,
    organizationShortDescription: org?.short_description,
    organizationSeoDescription: org?.seo_description,
    organizationLinkedinUrl: org?.linkedin_url,
    organizationTwitterUrl: org?.twitter_url,
    organizationFacebookUrl: org?.facebook_url,
    organizationBlogUrl: org?.blog_url,
    organizationCrunchbaseUrl: org?.crunchbase_url,
    organizationAngellistUrl: org?.angellist_url,
    organizationFoundedYear: org?.founded_year,
    organizationPrimaryPhone: org?.primary_phone?.number,
    organizationPubliclyTradedSymbol: org?.publicly_traded_symbol,
    organizationPubliclyTradedExchange: org?.publicly_traded_exchange,
    organizationAnnualRevenuePrinted: org?.annual_revenue_printed,
    organizationTotalFunding: org?.total_funding?.toString(),
    organizationTotalFundingPrinted: org?.total_funding_printed,
    organizationLatestFundingRoundDate: org?.latest_funding_round_date,
    organizationLatestFundingStage: org?.latest_funding_stage,
    organizationFundingEvents: org?.funding_events,
    organizationCity: org?.city,
    organizationState: org?.state,
    organizationCountry: org?.country,
    organizationStreetAddress: org?.street_address,
    organizationPostalCode: org?.postal_code,
    organizationRawAddress: org?.raw_address,
    organizationTechnologyNames: org?.technology_names,
    organizationCurrentTechnologies: org?.current_technologies,
    organizationKeywords: org?.keywords,
    organizationIndustries: org?.industries,
    organizationSecondaryIndustries: org?.secondary_industries,
    organizationNumSuborganizations: org?.num_suborganizations,
    organizationRetailLocationCount: org?.retail_location_count,
    organizationAlexaRanking: org?.alexa_ranking,
    raw: person as unknown as Record<string, unknown>,
  };
}

/**
 * Extract person/org DB values from an Apollo API person.
 * Returns only the data columns (caller adds orgId, runId, etc.).
 */
export function toEnrichmentDbValues(person: ApolloPerson) {
  const org = person.organization;
  return {
    apolloPersonId: person.id,
    firstName: person.first_name,
    lastName: person.last_name,
    name: person.name,
    email: person.email,
    emailStatus: person.email_status,
    title: person.title,
    linkedinUrl: person.linkedin_url,
    photoUrl: person.photo_url,
    headline: person.headline,
    city: person.city,
    state: person.state,
    country: person.country,
    seniority: person.seniority,
    departments: person.departments,
    subdepartments: person.subdepartments,
    functions: person.functions,
    twitterUrl: person.twitter_url,
    githubUrl: person.github_url,
    facebookUrl: person.facebook_url,
    personalEmails: person.personal_emails,
    mobilePhone: person.mobile_phone,
    phoneNumbers: person.phone_numbers,
    employmentHistory: person.employment_history,
    // Organization
    organizationId: org?.id,
    organizationName: org?.name,
    organizationDomain: org?.primary_domain,
    organizationIndustry: org?.industry,
    organizationSize: org?.estimated_num_employees?.toString(),
    organizationRevenueUsd: org?.annual_revenue?.toString(),
    organizationWebsiteUrl: org?.website_url,
    organizationLogoUrl: org?.logo_url,
    organizationShortDescription: org?.short_description,
    organizationSeoDescription: org?.seo_description,
    organizationLinkedinUrl: org?.linkedin_url,
    organizationTwitterUrl: org?.twitter_url,
    organizationFacebookUrl: org?.facebook_url,
    organizationBlogUrl: org?.blog_url,
    organizationCrunchbaseUrl: org?.crunchbase_url,
    organizationAngellistUrl: org?.angellist_url,
    organizationFoundedYear: org?.founded_year,
    organizationPrimaryPhone: org?.primary_phone?.number,
    organizationPubliclyTradedSymbol: org?.publicly_traded_symbol,
    organizationPubliclyTradedExchange: org?.publicly_traded_exchange,
    organizationAnnualRevenuePrinted: org?.annual_revenue_printed,
    organizationTotalFunding: org?.total_funding?.toString(),
    organizationTotalFundingPrinted: org?.total_funding_printed,
    organizationLatestFundingRoundDate: org?.latest_funding_round_date,
    organizationLatestFundingStage: org?.latest_funding_stage,
    organizationFundingEvents: org?.funding_events,
    organizationCity: org?.city,
    organizationState: org?.state,
    organizationCountry: org?.country,
    organizationStreetAddress: org?.street_address,
    organizationPostalCode: org?.postal_code,
    organizationRawAddress: org?.raw_address,
    organizationTechnologyNames: org?.technology_names,
    organizationCurrentTechnologies: org?.current_technologies,
    organizationKeywords: org?.keywords,
    organizationIndustries: org?.industries,
    organizationSecondaryIndustries: org?.secondary_industries,
    organizationNumSuborganizations: org?.num_suborganizations,
    organizationRetailLocationCount: org?.retail_location_count,
    organizationAlexaRanking: org?.alexa_ranking,
    responseRaw: { ...person, organization: person.organization ?? {} },
  };
}

/**
 * Transform a cached DB enrichment row back to the API response format.
 * Used when returning a cache hit from POST /enrich.
 */
export function transformCachedEnrichment(
  apolloPersonId: string,
  row: ApolloPeopleEnrichment
) {
  return {
    id: apolloPersonId,
    firstName: row.firstName,
    lastName: row.lastName,
    name: row.name,
    email: row.email,
    emailStatus: row.emailStatus,
    title: row.title,
    linkedinUrl: row.linkedinUrl,
    photoUrl: row.photoUrl,
    headline: row.headline,
    city: row.city,
    state: row.state,
    country: row.country,
    seniority: row.seniority,
    departments: row.departments,
    subdepartments: row.subdepartments,
    functions: row.functions,
    twitterUrl: row.twitterUrl,
    githubUrl: row.githubUrl,
    facebookUrl: row.facebookUrl,
    personalEmails: row.personalEmails,
    mobilePhone: row.mobilePhone,
    phoneNumbers: row.phoneNumbers,
    employmentHistory: row.employmentHistory,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    organizationDomain: row.organizationDomain,
    organizationIndustry: row.organizationIndustry,
    organizationSize: row.organizationSize,
    organizationRevenueUsd: row.organizationRevenueUsd,
    organizationWebsiteUrl: row.organizationWebsiteUrl,
    organizationLogoUrl: row.organizationLogoUrl,
    organizationShortDescription: row.organizationShortDescription,
    organizationSeoDescription: row.organizationSeoDescription,
    organizationLinkedinUrl: row.organizationLinkedinUrl,
    organizationTwitterUrl: row.organizationTwitterUrl,
    organizationFacebookUrl: row.organizationFacebookUrl,
    organizationBlogUrl: row.organizationBlogUrl,
    organizationCrunchbaseUrl: row.organizationCrunchbaseUrl,
    organizationAngellistUrl: row.organizationAngellistUrl,
    organizationFoundedYear: row.organizationFoundedYear,
    organizationPrimaryPhone: row.organizationPrimaryPhone,
    organizationPubliclyTradedSymbol: row.organizationPubliclyTradedSymbol,
    organizationPubliclyTradedExchange: row.organizationPubliclyTradedExchange,
    organizationAnnualRevenuePrinted: row.organizationAnnualRevenuePrinted,
    organizationTotalFunding: row.organizationTotalFunding,
    organizationTotalFundingPrinted: row.organizationTotalFundingPrinted,
    organizationLatestFundingRoundDate: row.organizationLatestFundingRoundDate,
    organizationLatestFundingStage: row.organizationLatestFundingStage,
    organizationFundingEvents: row.organizationFundingEvents,
    organizationCity: row.organizationCity,
    organizationState: row.organizationState,
    organizationCountry: row.organizationCountry,
    organizationStreetAddress: row.organizationStreetAddress,
    organizationPostalCode: row.organizationPostalCode,
    organizationRawAddress: row.organizationRawAddress,
    organizationTechnologyNames: row.organizationTechnologyNames,
    organizationCurrentTechnologies: row.organizationCurrentTechnologies,
    organizationKeywords: row.organizationKeywords,
    organizationIndustries: row.organizationIndustries,
    organizationSecondaryIndustries: row.organizationSecondaryIndustries,
    organizationNumSuborganizations: row.organizationNumSuborganizations,
    organizationRetailLocationCount: row.organizationRetailLocationCount,
    organizationAlexaRanking: row.organizationAlexaRanking,
    raw: row.responseRaw as Record<string, unknown> | null,
  };
}
