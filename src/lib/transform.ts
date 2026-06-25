import type { ApolloPerson, ApolloSearchParams } from "./apollo-client.js";
import type { ApolloPeopleEnrichment } from "../db/schema.js";

/**
 * Apollo's people-search `revenue_range` is a single `{min, max}` integer object,
 * NOT an array of "min,max" strings. Callers/LLMs emit `revenueRange` as the
 * documented string-array filter shape (e.g. `["1000000,10000000"]`); collapse
 * it to the one `{min, max}` object Apollo accepts. Multiple ranges union into a
 * single span (min of mins, max of maxes) since Apollo supports only one range;
 * an open-ended bound (e.g. `"10001,"`) omits that key. Sending the array form
 * makes Apollo's Ruby do `array["min"]` → 422 "no implicit conversion of String
 * into Integer". Defensively passes an already-`{min,max}` input straight through.
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
 * Map camelCase search filter params to Apollo's snake_case API format.
 * Shared by POST /search and POST /search/next.
 */
export function toApolloSearchParams(sp: Record<string, unknown>): ApolloSearchParams {
  // Prefer the native {min,max} revenue object when supplied; else collapse the
  // legacy `revenueRange` string-array into Apollo's required {min,max}.
  const revenueNative = cleanRange<number>(sp.revenueRangeNative);

  return {
    person_titles: sp.personTitles as string[] | undefined,
    q_organization_keyword_tags: sp.qOrganizationKeywordTags as string[] | undefined,
    organization_locations: sp.organizationLocations as string[] | undefined,
    organization_num_employees_ranges: sp.organizationNumEmployeesRanges as string[] | undefined,
    q_organization_industry_tag_ids: sp.qOrganizationIndustryTagIds as string[] | undefined,
    q_keywords: sp.qKeywords as string | undefined,
    person_locations: sp.personLocations as string[] | undefined,
    person_seniorities: sp.personSeniorities as string[] | undefined,
    contact_email_status: sp.contactEmailStatus as string[] | undefined,
    q_organization_domains: sp.qOrganizationDomains as string[] | undefined,
    currently_using_any_of_technology_uids: sp.currentlyUsingAnyOfTechnologyUids as string[] | undefined,
    revenue_range: revenueNative ?? toApolloRevenueRange(sp.revenueRange),
    organization_ids: sp.organizationIds as string[] | undefined,
    // ── Faithful Apollo People Search params (additive) ──
    include_similar_titles: sp.includeSimilarTitles as boolean | undefined,
    q_organization_job_titles: sp.qOrganizationJobTitles as string[] | undefined,
    person_linkedin_urls: sp.personLinkedinUrls as string[] | undefined,
    currently_using_all_of_technology_uids: sp.currentlyUsingAllOfTechnologyUids as string[] | undefined,
    currently_not_using_any_of_technology_uids: sp.currentlyNotUsingAnyOfTechnologyUids as string[] | undefined,
    q_organization_domains_list: sp.qOrganizationDomainsList as string[] | undefined,
    market_segments: sp.marketSegments as string[] | undefined,
    organization_naics_codes: sp.organizationNaicsCodes as string[] | undefined,
    not_organization_naics_codes: sp.notOrganizationNaicsCodes as string[] | undefined,
    organization_sic_codes: sp.organizationSicCodes as string[] | undefined,
    not_organization_sic_codes: sp.notOrganizationSicCodes as string[] | undefined,
    organization_job_locations: sp.organizationJobLocations as string[] | undefined,
    organization_founded_year_range: cleanRange<number>(sp.organizationFoundedYearRange),
    organization_include_unknown_founded_year: sp.organizationIncludeUnknownFoundedYear as boolean | undefined,
    organization_headcount_growth_past_n_months: sp.organizationHeadcountGrowthPastNMonths as number | undefined,
    organization_headcount_growth_range: cleanRange<number>(sp.organizationHeadcountGrowthRange),
    organization_num_jobs_range: cleanRange<number>(sp.organizationNumJobsRange),
    organization_job_posted_at_range: cleanRange<string>(sp.organizationJobPostedAtRange),
    person_total_yoe_range: cleanRange<number>(sp.personTotalYoeRange),
    person_days_in_current_title_range: cleanRange<number>(sp.personDaysInCurrentTitleRange),
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
