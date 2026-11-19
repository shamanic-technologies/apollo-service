/**
 * FREE people sources ahead of Apollo (APOLLO-ZERO-COST-1119, owner 2026-11-19:
 * « Apollo en dernier, si tout le free a été testé »). Pure rules: Apollo filters
 * → each source's request, and each source's row → our Person wire shape.
 *
 * Measured live 2026-11-19 through treg (both $0 per call, `X-Treg-Cost-Micro: 0`):
 * - **Leadsforge** (`leadsforge.people.search`): full name + company DOMAIN, no
 *   LinkedIn URL. Seniorities are Apollo's own values. ABA-therapy owners in 7
 *   states: 10 of 10 on target where QuickEnrich had 0 of 30.
 * - **Dropleads** (`dropleads.people.search`): full name + LinkedIn URL in
 *   Apollo's own form, company NAME only (no domain). Industries use Apollo's
 *   (old LinkedIn) taxonomy; seniority `c_suite` is spelled `csuite`, the rest
 *   are Apollo's; person location = `countries` + `states` + `cities` (plain
 *   lists; `personalStates` as a plain list is silently dropped, measured by
 *   count delta). Same ABA target: 1,868 people, 10 of 10 on target.
 *
 * Serving rule, per source: a source is used for an audience only when it
 * ENFORCES every TARGETING constraint (titles, seniorities, sector: tags /
 * industries / keywords, technologies, person + company location, headcount).
 * QuickEnrich showed what serving without the sector filter does (0 of 30
 * accepted on a sector audience, and a pool that never ends). What a source
 * cannot enforce of the rest (revenue, funding, founded year, an unaligned
 * headcount span) is left to the consumer's pre-pay judge, named.
 */

import { canonicalCountry, parseApolloLocation, US_STATES } from "./quickenrich.js";

export type FreeSource = "leadsforge" | "dropleads";

export type SourcePlan =
  | { ok: true; source: FreeSource; filters: Record<string, unknown>; leftToJudge: string[] }
  | { ok: false; source: FreeSource; reasons: string[] };

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined || v === "" || v === false) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).every((x) => x === null || x === undefined);
  return false;
}

function strings(v: unknown): string[] {
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : [];
}

// Every spelling a stored audience uses for each Apollo field.
const ALIASES = {
  titles: ["person_titles", "personTitles"],
  notTitles: ["person_not_titles", "personNotTitles"],
  similar: ["include_similar_titles", "includeSimilarTitles"],
  seniorities: ["person_seniorities", "personSeniorities"],
  personLocations: ["person_locations", "personLocations"],
  orgLocations: ["organization_locations", "organizationLocations"],
  tags: ["q_organization_keyword_tags", "qOrganizationKeywordTags"],
  notTags: ["q_not_organization_keyword_tags", "qNotOrganizationKeywordTags"],
  keywords: ["q_keywords", "qKeywords"],
  industries: ["organization_industries", "organizationIndustries"],
  technologies: ["currently_using_any_of_technology_uids", "currentlyUsingAnyOfTechnologyUids"],
  employees: ["organization_num_employees_ranges", "organizationNumEmployeesRanges"],
  emailStatus: ["contact_email_status", "contactEmailStatus"],
  signal: ["buying_signal", "buyingSignal"],
  // Left to the judge when present (no source enforces them faithfully here).
  revenue: ["revenue_range", "revenueRangeNative", "revenueRange"],
  funding: [
    "total_funding_range", "totalFundingRange", "latest_funding_amount_range", "latestFundingAmountRange",
    "latest_funding_date_range", "latestFundingDateRange", "organization_latest_funding_stage_cd", "organizationLatestFundingStageCd",
  ],
  founded: ["organization_founded_year_range", "organizationFoundedYearRange"],
} as const;

type Field = keyof typeof ALIASES;
const KNOWN = new Set<string>(Object.values(ALIASES).flat());

function pick(filters: Record<string, unknown>, field: Field): unknown {
  for (const k of ALIASES[field]) if (!isEmpty(filters[k])) return filters[k];
  return undefined;
}

function has(filters: Record<string, unknown>, field: Field): boolean {
  return pick(filters, field) !== undefined;
}

/** Envelope {min,max} of Apollo "min,max" spans; `exact` false when several disjoint spans were merged. */
export function employeeEnvelope(ranges: string[]): { min: number; max: number | null; exact: boolean } | null {
  let min = Infinity;
  let max: number | null = -Infinity;
  const spans: Array<[number, number | null]> = [];
  for (const r of ranges) {
    const [a, b] = r.split(",").map((s) => s.trim());
    const lo = a ? Number(a) : 1;
    const hi = b ? Number(b) : null;
    if (!Number.isFinite(lo) || (hi !== null && !Number.isFinite(hi))) return null;
    spans.push([lo, hi]);
    min = Math.min(min, lo);
    max = hi === null || max === null ? null : Math.max(max, hi);
  }
  if (spans.length === 0) return null;
  spans.sort((x, y) => x[0] - y[0]);
  let exact = true;
  for (let i = 1; i < spans.length; i++) {
    const prevHi = spans[i - 1][1];
    if (prevHi !== null && spans[i][0] > prevHi + 1) exact = false;
  }
  return { min, max: max === -Infinity ? null : max, exact };
}

/** Apollo person locations → plain place names (country / US state / city), or null when one cannot be read. */
function placeNames(raw: string[]): { countries: string[]; states: string[]; cities: string[] } | null {
  const out = { countries: new Set<string>(), states: new Set<string>(), cities: new Set<string>() };
  for (const r of raw) {
    const loc = parseApolloLocation(r);
    if (!loc) return null;
    const country = loc.country ? canonicalCountry(loc.country) : null;
    if (country) out.countries.add(country);
    if (loc.city) out.cities.add(titleCase(loc.city));
    else if (loc.region) {
      if (US_STATES.has(loc.region)) out.states.add(titleCase(loc.region));
      else out.cities.add(titleCase(loc.region));
    }
  }
  return { countries: [...out.countries], states: [...out.states], cities: [...out.cities] };
}

function titleCase(s: string): string {
  return s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

function commonRefusals(filters: Record<string, unknown>, source: FreeSource, enforced: Field[]): string[] {
  const reasons: string[] = [];
  if (has(filters, "signal")) reasons.push("buying_signal: a dated window this source cannot see");
  if (!has(filters, "titles") && !has(filters, "tags") && !has(filters, "industries") && !has(filters, "keywords")) {
    reasons.push("no title, tag, industry or keyword to search on");
  }
  for (const [k, v] of Object.entries(filters)) {
    if (!isEmpty(v) && !KNOWN.has(k)) reasons.push(`${k}: not translated for ${source}`);
  }
  const targeting: Field[] = ["seniorities", "tags", "notTags", "keywords", "industries", "technologies", "orgLocations"];
  for (const f of targeting) if (has(filters, f) && !enforced.includes(f)) reasons.push(`${ALIASES[f][0]}: not enforced by ${source}`);
  return reasons;
}

function judged(filters: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (has(filters, "revenue")) out.push("revenue_range: left to the judge");
  if (has(filters, "funding")) out.push("funding filters: left to the judge");
  if (has(filters, "founded")) out.push("organization_founded_year_range: left to the judge");
  return out;
}

export function planLeadsforge(filters: Record<string, unknown>): SourcePlan {
  const source = "leadsforge" as const;
  const reasons = commonRefusals(filters, source, ["seniorities", "tags", "notTags", "keywords", "technologies", "orgLocations"]);
  const leftToJudge = judged(filters);
  const body: Record<string, unknown> = {};
  const titles = strings(pick(filters, "titles"));
  const notTitles = strings(pick(filters, "notTitles"));
  if (titles.length || notTitles.length) body.leadJobTitles = { include: titles, exclude: notTitles };
  const seniorities = strings(pick(filters, "seniorities"));
  if (seniorities.length) body.leadSeniorities = { include: seniorities, exclude: [] };
  const personLocs = strings(pick(filters, "personLocations"));
  if (personLocs.length) {
    const places = placeNames(personLocs);
    if (!places) reasons.push(`person_locations: ${JSON.stringify(personLocs)} cannot be read`);
    else body.leadLocations = { include: [...places.cities, ...places.states, ...(places.cities.length || places.states.length ? [] : places.countries)], exclude: [] };
  }
  const orgLocs = strings(pick(filters, "orgLocations"));
  if (orgLocs.length) body.companyLocations = { include: orgLocs.map((l) => l.split(",")[0].trim()), exclude: [] };
  const tags = [...strings(pick(filters, "tags")), ...strings(pick(filters, "keywords"))];
  const notTags = strings(pick(filters, "notTags"));
  if (tags.length || notTags.length) body.companyKeywords = { include: tags, exclude: notTags };
  const tech = strings(pick(filters, "technologies"));
  if (tech.length) body.companyTechnologies = { any: tech.map((t) => t.replace(/_/g, " ")) };
  const employees = strings(pick(filters, "employees"));
  if (employees.length) {
    const env = employeeEnvelope(employees);
    if (!env) reasons.push(`organization_num_employees_ranges: ${JSON.stringify(employees)} is not a readable span`);
    else {
      body.companyEmployeeNumberRange = env.max === null ? { min: env.min } : { min: env.min, max: env.max };
      if (!env.exact) leftToJudge.push("organization_num_employees_ranges: several spans merged into one envelope, exact spans left to the judge");
    }
  }
  if (reasons.length) return { ok: false, source, reasons };
  return { ok: true, source, filters: body, leftToJudge };
}

const DROPLEADS_SENIORITY: Record<string, string> = { c_suite: "csuite" };

export function planDropleads(filters: Record<string, unknown>): SourcePlan {
  const source = "dropleads" as const;
  const reasons = commonRefusals(filters, source, ["seniorities", "tags", "notTags", "keywords", "industries", "technologies", "orgLocations"]);
  const leftToJudge = judged(filters);
  const f: Record<string, unknown> = { requireEmail: true };
  const titles = strings(pick(filters, "titles"));
  if (titles.length) f.jobTitles = titles;
  const notTitles = strings(pick(filters, "notTitles"));
  if (notTitles.length) f.jobTitlesExclude = notTitles;
  const seniorities = strings(pick(filters, "seniorities"));
  if (seniorities.length) f.seniority = seniorities.map((s) => DROPLEADS_SENIORITY[s] ?? s);
  const personLocs = strings(pick(filters, "personLocations"));
  if (personLocs.length) {
    const places = placeNames(personLocs);
    if (!places) reasons.push(`person_locations: ${JSON.stringify(personLocs)} cannot be read`);
    else {
      if (places.countries.length) f.countries = places.countries;
      if (places.states.length) f.states = places.states;
      if (places.cities.length) f.cities = places.cities;
    }
  }
  const orgLocs = strings(pick(filters, "orgLocations"));
  if (orgLocs.length) {
    const places = placeNames(orgLocs);
    if (!places) reasons.push(`organization_locations: ${JSON.stringify(orgLocs)} cannot be read`);
    // An organization scope is an {include} OBJECT: a plain list is silently ignored by
    // Dropleads (measured 2026-11-19: 36,879 with or without ["Nigeria"], 18 with {include}).
    else f.organizationCountries = { include: places.countries };
    if (places && (places.states.length || places.cities.length)) leftToJudge.push("organization_locations: state / city left to the judge");
  }
  const tags = [...strings(pick(filters, "tags")), ...strings(pick(filters, "keywords"))];
  if (tags.length) f.keywords = tags;
  const notTags = strings(pick(filters, "notTags"));
  if (notTags.length) f.keywordsExclude = notTags;
  const industries = strings(pick(filters, "industries"));
  if (industries.length) f.industries = industries;
  const tech = strings(pick(filters, "technologies"));
  if (tech.length) f.technologies = tech.map((t) => t.replace(/_/g, " "));
  const employees = strings(pick(filters, "employees"));
  if (employees.length) {
    const env = employeeEnvelope(employees);
    if (!env) reasons.push(`organization_num_employees_ranges: ${JSON.stringify(employees)} is not a readable span`);
    else {
      f.customEmployeeRange = env.max === null ? { min: env.min } : { min: env.min, max: env.max };
      if (!env.exact) leftToJudge.push("organization_num_employees_ranges: several spans merged into one envelope, exact spans left to the judge");
    }
  }
  if (reasons.length) return { ok: false, source, reasons };
  return { ok: true, source, filters: f, leftToJudge };
}

// ─── Rows → our Person wire shape ────────────────────────────────────────────

export const FREE_SOURCE_PREFIX: Record<FreeSource, string> = { leadsforge: "lf:", dropleads: "dl:" };

export function parseFreeSourcePersonId(id: string): { source: FreeSource; externalId: string } | null {
  for (const [source, prefix] of Object.entries(FREE_SOURCE_PREFIX) as Array<[FreeSource, string]>) {
    if (id.startsWith(prefix) && id.length > prefix.length) return { source, externalId: id.slice(prefix.length) };
  }
  return null;
}

/** One row of a free source, normalized (silver). Null fields are absent in the source, never guessed. */
export interface FreeSourcePerson {
  source: FreeSource;
  externalId: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  linkedinUrl: string | null;
  companyName: string | null;
  companyDomain: string | null;
  industry: string | null;
  employees: number | null;
  city: string | null;
  state: string | null;
  country: string | null;
}

function clean(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" || /^n\/?a$/i.test(s) ? null : s;
}

function domainOf(v: unknown): string | null {
  const s = clean(v);
  if (!s) return null;
  return s.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "") || null;
}

export function normalizeLeadsforgeRow(row: Record<string, unknown>): FreeSourcePerson | null {
  const company = (row.company ?? {}) as Record<string, unknown>;
  const loc = (row.location ?? {}) as Record<string, unknown>;
  const id = clean(row.id);
  if (!id) return null;
  return {
    source: "leadsforge",
    externalId: id,
    firstName: clean(row.firstName),
    lastName: clean(row.lastName),
    title: clean(row.jobTitle),
    linkedinUrl: clean(row.linkedinUrl ?? row.linkedInUrl),
    companyName: clean(company.name),
    companyDomain: domainOf(company.domain ?? company.website),
    industry: clean(company.industry),
    employees: typeof company.employeeCount === "number" ? company.employeeCount : null,
    city: clean(loc.city),
    state: clean(loc.state),
    country: clean(loc.country),
  };
}

export function normalizeDropleadsRow(row: Record<string, unknown>): FreeSourcePerson | null {
  const id = clean(row.id);
  if (!id) return null;
  return {
    source: "dropleads",
    externalId: id,
    firstName: clean(row.firstName),
    lastName: clean(row.lastName),
    title: clean(row.title),
    linkedinUrl: clean(row.linkedinUrl),
    companyName: clean(row.companyName),
    companyDomain: domainOf(row.companyDomain ?? row.companyWebsite),
    industry: clean(row.industry),
    employees: typeof row.companySize === "number" ? row.companySize : null,
    city: clean(row.city),
    state: clean(row.state),
    country: clean(row.country),
  };
}

/**
 * Servable = we can find the email without Apollo: a full name AND either a
 * LinkedIn profile or a company domain (treg's two find identities).
 */
export function isServable(p: FreeSourcePerson): boolean {
  if (!p.firstName || !p.lastName) return false;
  return Boolean((p.linkedinUrl && /linkedin\.com\/in\//i.test(p.linkedinUrl)) || p.companyDomain);
}

/** The Person wire shape /search/next and /enrich serve (same keys as an Apollo person; absent = null). */
export function freeSourceToPerson(p: FreeSourcePerson, email: { email: string | null; emailStatus: string | null } = { email: null, emailStatus: null }) {
  return {
    id: `${FREE_SOURCE_PREFIX[p.source]}${p.externalId}`,
    firstName: p.firstName,
    lastName: p.lastName,
    name: [p.firstName, p.lastName].filter(Boolean).join(" ") || null,
    email: email.email,
    emailStatus: email.emailStatus,
    title: p.title,
    linkedinUrl: p.linkedinUrl,
    photoUrl: null,
    headline: null,
    city: p.city,
    state: p.state,
    country: p.country,
    timeZone: null,
    seniority: null,
    departments: null,
    subdepartments: null,
    functions: null,
    employmentHistory: null,
    organizationId: null,
    organizationName: p.companyName,
    organizationDomain: p.companyDomain,
    organizationIndustry: p.industry,
    organizationSize: p.employees === null ? null : String(p.employees),
    organizationRevenueUsd: null,
    organizationAnnualRevenue: null,
    organizationAnnualRevenuePrinted: null,
    organizationWebsiteUrl: p.companyDomain ? `https://${p.companyDomain}` : null,
    organizationLinkedinUrl: null,
    organizationCity: null,
    organizationState: null,
    organizationCountry: null,
  };
}
