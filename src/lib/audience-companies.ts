/**
 * "Who does this Apollo audience reach, company by company?" — up to 100
 * distinct companies where people OF THE AUDIENCE work, each with Apollo's
 * firmographics and the one person to write to (consumer: human-service, then
 * the distribute.you signed-out onboarding).
 *
 * THREE STEPS, only the last one paid (all measured on prod 2026-09-29 against
 * `credit_usage_stats` before/after, zero baseline drift):
 *
 * 1. EMPLOYERS (free) — the audience's own people-search teaser, the same
 *    instrument as the preview, so every person-level filter (titles,
 *    seniorities, …) holds. Distinct employers in Apollo's rank order; the
 *    FIRST-ranked person at each employer is its "one right person". Page 1,
 *    then pages 2..5 in parallel only when page 1 did not hold enough employers.
 *    The teaser redacts every org field except `name`, and carries no org id.
 * 2. ORGANIZATION ID (free) — `organizations/search` in fuzzy_select_mode,
 *    Apollo's free lookup: 0 credits over 101 calls. An employer resolves only
 *    to a candidate whose name is EXACTLY the teaser's employer name (case and
 *    whitespace aside). Several exact candidates are disambiguated by a free
 *    people search restricted to each candidate id: the first that holds a
 *    person of the audience wins, none wins ⟹ no id. Never a fuzzy guess.
 * 3. FIRMOGRAPHICS (billed) — `GET organizations/{id}`, 1 lead credit per
 *    company. The cheaper paths were measured and rejected:
 *    `mixed_companies/search` with 100 `organization_ids` costs 1 credit per
 *    REQUEST (96 companies for 1 credit) but no longer returns industry,
 *    headcount, location or description; `organizations/bulk_enrich` is 1 per
 *    company like the GET but keyed on a domain. Firmographics are global facts,
 *    so they are cached in `apollo_organizations` for `ORG_CACHE_DAYS` and a
 *    cached company is never paid for again, whoever asks.
 *
 * No email, no phone (not even the company switchboard), no filter object ever
 * leaves this module's output.
 */
import { toApolloSearchParams } from "./transform.js";
import type { CreditAlertIdentity } from "./credit-alert.js";
import {
  searchPeople,
  lookupOrganizationsByName,
  type ApolloOrganization,
  type ApolloOrganizationCandidate,
  type ApolloPerson,
  type ApolloSearchResponse,
} from "./apollo-client.js";

export const MAX_COMPANIES = 100;
export const DEFAULT_COMPANIES_LIMIT = 25;
/** Teaser pages walked at most (500 people). Free, but bounded for latency and Apollo's 200/min rate limit. */
export const MAX_TEASER_PAGES = 5;
const TEASER_PAGE_SIZE = 100;
const LOOKUP_PER_PAGE = 10;
export const LOOKUP_CONCURRENCY = 10;
/** Firmographics are reused for this long before being paid for again. */
export const ORG_CACHE_DAYS = 90;
export const COMPANY_FIRMOGRAPHICS_COST_NAME = "apollo-credit";

type TeaserPerson = ApolloPerson & { last_name_obfuscated?: string | null };

export interface CompanyPerson {
  /** The handle `POST /enrich` accepts to reveal + verify this person's email (billed there, not here). */
  apolloPersonId: string | null;
  firstName: string | null;
  lastNameObfuscated: string | null;
  title: string | null;
}

export interface Employer {
  name: string;
  key: string;
  peopleInSample: number;
  person: CompanyPerson;
}

export interface CompanyFirmographics {
  apolloOrganizationId: string | null;
  domain: string | null;
  websiteUrl: string | null;
  logoUrl: string | null;
  linkedinUrl: string | null;
  shortDescription: string | null;
  industry: string | null;
  estimatedNumEmployees: number | null;
  city: string | null;
  state: string | null;
  country: string | null;
  foundedYear: number | null;
  annualRevenuePrinted: string | null;
  totalFundingPrinted: string | null;
  latestFundingStage: string | null;
  keywords: string[];
}

export interface AudienceCompany extends CompanyFirmographics {
  rank: number;
  name: string;
  peopleInSample: number;
  person: CompanyPerson;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function normalizeCompanyName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Pure: distinct employers in Apollo rank order across the given teaser pages.
 * The first person seen at an employer is its person; later ones only count.
 * A person with no employer name is skipped (nothing to show a company for).
 */
export function groupEmployers(people: TeaserPerson[]): Employer[] {
  const byKey = new Map<string, Employer>();
  for (const p of people) {
    const name = str(p.organization?.name);
    if (!name) continue;
    const key = normalizeCompanyName(name);
    const existing = byKey.get(key);
    if (existing) {
      existing.peopleInSample++;
      continue;
    }
    byKey.set(key, {
      name,
      key,
      peopleInSample: 1,
      person: {
        apolloPersonId: str(p.id),
        firstName: str(p.first_name),
        lastNameObfuscated: str(p.last_name_obfuscated),
        title: str(p.title),
      },
    });
  }
  return [...byKey.values()];
}

export interface EmployerCollection {
  count: number;
  employers: Employer[];
  /** A teaser page we did not walk may still hold new employers. */
  morePages: boolean;
}

/** Step 1 (free): enough distinct employers for `needed`, capped at MAX_TEASER_PAGES. */
export async function collectEmployers(
  apiKey: string,
  filters: Record<string, unknown>,
  needed: number,
  alertIdentity?: CreditAlertIdentity,
): Promise<EmployerCollection> {
  const params = toApolloSearchParams(filters);
  const fetchPage = (page: number) => searchPeople(apiKey, { ...params, page, per_page: TEASER_PAGE_SIZE }, alertIdentity);

  const first = await fetchPage(1);
  const count = first.total_entries ?? first.pagination?.total_entries ?? 0;
  const totalPages = Math.min(Math.ceil(count / TEASER_PAGE_SIZE), MAX_TEASER_PAGES);
  const pages: ApolloSearchResponse[] = [first];
  let walked = 1;

  if (groupEmployers(first.people ?? []).length < needed && totalPages > 1) {
    const rest = await Promise.all(Array.from({ length: totalPages - 1 }, (_, i) => fetchPage(i + 2)));
    pages.push(...rest);
    walked = totalPages;
  }

  const employers = groupEmployers(pages.flatMap((p) => (p.people ?? []) as TeaserPerson[]));
  const lastFull = (pages[pages.length - 1].people ?? []).length >= TEASER_PAGE_SIZE;
  return { count, employers, morePages: lastFull && walked < totalPages };
}

/**
 * Step 2 (free): the Apollo organization id of an employer, or null when no
 * candidate carries exactly its name or none of several holds a person of the
 * audience. Returns the chosen shallow candidate (domain, website, logo).
 */
export async function resolveOrganization(
  apiKey: string,
  filters: Record<string, unknown>,
  employer: Employer,
  alertIdentity?: CreditAlertIdentity,
): Promise<ApolloOrganizationCandidate | null> {
  const candidates = await lookupOrganizationsByName(apiKey, employer.name, LOOKUP_PER_PAGE, alertIdentity);
  const exact = candidates.filter((c) => typeof c.id === "string" && c.name && normalizeCompanyName(c.name) === employer.key);
  if (exact.length <= 1) return exact[0] ?? null;

  const params = toApolloSearchParams(filters);
  const allowed = params.organization_ids;
  for (const candidate of exact) {
    if (allowed && allowed.length > 0 && !allowed.includes(candidate.id)) continue;
    const res = await searchPeople(apiKey, { ...params, organization_ids: [candidate.id], page: 1, per_page: 1 }, alertIdentity);
    if ((res.total_entries ?? res.pagination?.total_entries ?? 0) > 0) return candidate;
  }
  return null;
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
export async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Pure: the firmographics shown for a company. The full record (billed, cached)
 * wins; the free lookup's domain/website/logo stand in when there is none. A
 * field Apollo does not give is null — nothing is inferred.
 */
export function toFirmographics(
  candidate: ApolloOrganizationCandidate | null,
  org: ApolloOrganization | null,
): CompanyFirmographics {
  const o = (org ?? {}) as Partial<ApolloOrganization> & { organization_revenue_printed?: string };
  return {
    apolloOrganizationId: str(org?.id) ?? str(candidate?.id),
    domain: str(o.primary_domain) ?? str(candidate?.domain),
    websiteUrl: str(o.website_url) ?? str(candidate?.website_url),
    logoUrl: str(o.logo_url) ?? str(candidate?.logo_url),
    linkedinUrl: str(o.linkedin_url),
    shortDescription: str(o.short_description),
    industry: str(o.industry),
    estimatedNumEmployees: num(o.estimated_num_employees),
    city: str(o.city),
    state: str(o.state),
    country: str(o.country),
    foundedYear: num(o.founded_year),
    annualRevenuePrinted: str(o.annual_revenue_printed) ?? str(o.organization_revenue_printed),
    totalFundingPrinted: str(o.total_funding_printed),
    latestFundingStage: str(o.latest_funding_stage),
    keywords: Array.isArray(o.keywords) ? o.keywords.filter((k): k is string => typeof k === "string" && k.trim().length > 0).slice(0, 10) : [],
  };
}
