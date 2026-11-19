/**
 * Our STOCK of company firmographics (APOLLO-ZERO-COST-1119). A QuickEnrich
 * person arrives with industry, headcount BAND and revenue band only, so the
 * filters QuickEnrich cannot enforce (keyword tags, technologies, funding,
 * founded year) used to reach the consumer's pre-pay judge with nothing to
 * judge on. Our paid Apollo reveals already hold all of it per employer
 * domain (`apollo_people_enrichments`, 52,572 domains, 49,797 with keywords;
 * 1,334 of 1,774 QuickEnrich employers measured 2026-11-19). Free: a read of
 * facts we paid for, any org (firmographics are facts about a company, like
 * the global `apollo_organizations` cache). Never a fact we do not hold:
 * absent stays absent.
 *
 * human-service already carries these fields from a served person into the
 * teaser its judge reads (`organizationKeywords` → keywords, `organizationSize`
 * → employees), so no consumer change is needed.
 */

import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { pgTextArray } from "./bulk-params.js";
import { normalizeDomain } from "./email-finders.js";

export interface CompanyStockFacts {
  domain: string;
  size: string | null;
  revenueUsd: number | null;
  foundedYear: number | null;
  keywords: string[] | null;
  industries: string[] | null;
  secondaryIndustries: string[] | null;
  technologyNames: string[] | null;
  shortDescription: string | null;
  latestFundingStage: string | null;
  latestFundingRoundDate: string | null;
  totalFundingPrinted: string | null;
  publiclyTradedSymbol: string | null;
}

function list(v: unknown): string[] | null {
  return Array.isArray(v) && v.length > 0 ? v.filter((x): x is string => typeof x === "string") : null;
}

/** Latest stocked firmographics per employer domain (normalized), for every domain we hold. */
export async function loadCompanyStock(domains: Array<string | null | undefined>): Promise<Map<string, CompanyStockFacts>> {
  const wanted = [...new Set(domains.map((d) => normalizeDomain(d ?? "")).filter((d) => d !== ""))];
  const out = new Map<string, CompanyStockFacts>();
  if (wanted.length === 0) return out;
  const rows = (await db.execute(sql`
    SELECT DISTINCT ON (lower(organization_domain))
           lower(organization_domain) AS domain, organization_size, organization_revenue_usd, organization_founded_year,
           organization_keywords, organization_industries, organization_secondary_industries, organization_technology_names,
           organization_short_description, organization_latest_funding_stage, organization_latest_funding_round_date,
           organization_total_funding_printed, organization_publicly_traded_symbol
      FROM apollo_people_enrichments
     WHERE lower(organization_domain) = ANY(${pgTextArray(wanted)}::text[])
     ORDER BY lower(organization_domain), created_at DESC`)) as unknown as Array<Record<string, unknown>>;
  for (const r of rows) {
    const domain = String(r.domain);
    out.set(domain, {
      domain,
      size: r.organization_size == null ? null : String(r.organization_size),
      revenueUsd: r.organization_revenue_usd == null ? null : Number(r.organization_revenue_usd),
      foundedYear: typeof r.organization_founded_year === "number" ? r.organization_founded_year : null,
      keywords: list(r.organization_keywords),
      industries: list(r.organization_industries),
      secondaryIndustries: list(r.organization_secondary_industries),
      technologyNames: list(r.organization_technology_names),
      shortDescription: typeof r.organization_short_description === "string" ? r.organization_short_description : null,
      latestFundingStage: typeof r.organization_latest_funding_stage === "string" ? r.organization_latest_funding_stage : null,
      latestFundingRoundDate: typeof r.organization_latest_funding_round_date === "string" ? r.organization_latest_funding_round_date : null,
      totalFundingPrinted: typeof r.organization_total_funding_printed === "string" ? r.organization_total_funding_printed : null,
      publiclyTradedSymbol: typeof r.organization_publicly_traded_symbol === "string" ? r.organization_publicly_traded_symbol : null,
    });
  }
  return out;
}

/** The person with the stocked firmographics of its employer; unchanged when we hold none. */
export function applyCompanyStock<P extends { organizationSize: string | null; organizationRevenueUsd: number | null }>(person: P, facts: CompanyStockFacts | null) {
  if (!facts) return person;
  return {
    ...person,
    organizationSize: person.organizationSize ?? facts.size,
    organizationRevenueUsd: person.organizationRevenueUsd ?? facts.revenueUsd,
    organizationFoundedYear: facts.foundedYear,
    organizationKeywords: facts.keywords,
    organizationIndustries: facts.industries,
    organizationSecondaryIndustries: facts.secondaryIndustries,
    organizationTechnologyNames: facts.technologyNames,
    organizationShortDescription: facts.shortDescription,
    organizationLatestFundingStage: facts.latestFundingStage,
    organizationLatestFundingRoundDate: facts.latestFundingRoundDate,
    organizationTotalFundingPrinted: facts.totalFundingPrinted,
    organizationPubliclyTradedSymbol: facts.publiclyTradedSymbol,
  };
}
