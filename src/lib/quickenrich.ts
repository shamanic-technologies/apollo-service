/**
 * QuickEnrich people search (via treg) as a FREE candidate source for an
 * audience, and the faithfulness contract that decides whether an audience's
 * Apollo filters can be served from it at all.
 *
 * Measured live 2026-09-26 (treg `quickenrich.people.search`,
 * `POST /call/quickenrich.people.search`):
 * - Free: `X-Treg-Cost-Micro: 0`, `meta.credits_used: 0`. Every row carries the
 *   full name, the LinkedIn URL and the company domain — the identity the
 *   Apollo teaser hides — so the email find can be skipped for anybody
 *   already served, BEFORE any spend.
 * - `title` and `locality` filters are case-insensitive SUBSTRING matches
 *   (`locality: "Texas"` → 314 chiropractors, `"United States"` → 5,657).
 * - `locality` is the PERSON's LinkedIn location ("Austin, Texas, United
 *   States", often "N/A"). `city` / `region_code` / `country_code` are the
 *   COMPANY's address (every Salesforce row reads "San Francisco, CA", some
 *   with `country_code: "UK"`), so they can NOT stand in for a person
 *   location, and they are too unreliable to stand in for an organization one.
 * - `number_of_employees` / `revenue` accept only their lookup bands
 *   (`/api/lookups/employee-ranges`, `/api/lookups/revenue-ranges`).
 *
 * Faithfulness rule: an audience is served from QuickEnrich only when EVERY
 * constraint its Apollo filters state can be enforced — server-side or by a
 * free post-filter on the returned row. Any constraint that cannot (keyword
 * tags, seniorities, industries, organization locations, technologies, …)
 * makes the whole audience inexpressible and it stays on Apollo. Enforcing is
 * allowed to be STRICTER than Apollo (a person whose location reads "Greater
 * Seattle Area" is dropped from a "Washington, US" audience); it is never
 * allowed to be looser.
 */

// ─── Vocabulary ──────────────────────────────────────────────────────────────

export const QUICKENRICH_SEARCH_URL = "https://treg.to/call/quickenrich.people.search";

/** Rows per page (QuickEnrich's max). */
export const QUICKENRICH_PAGE_SIZE = 100;

/** QuickEnrich employee bands, inclusive [min, max] (max null = open). */
export const QE_EMPLOYEE_BANDS: ReadonlyArray<{ label: string; min: number; max: number | null }> = [
  { label: "< 5", min: 1, max: 4 },
  { label: "5 - 19", min: 5, max: 19 },
  { label: "20 - 99", min: 20, max: 99 },
  { label: "100 - 249", min: 100, max: 249 },
  { label: "250 - 499", min: 250, max: 499 },
  { label: "500 - 999", min: 500, max: 999 },
  { label: "1000 - 4999", min: 1000, max: 4999 },
  { label: "5000 - 9999", min: 5000, max: 9999 },
  { label: ">10000", min: 10000, max: null },
];

/** QuickEnrich revenue bands in USD, [min, max) (max null = open). */
export const QE_REVENUE_BANDS: ReadonlyArray<{ label: string; min: number; max: number | null }> = [
  { label: "< 500k", min: 0, max: 500_000 },
  { label: "500k - 1 Million", min: 500_000, max: 1_000_000 },
  { label: "1 - 2.5 Million", min: 1_000_000, max: 2_500_000 },
  { label: "2.5 - 5 Million", min: 2_500_000, max: 5_000_000 },
  { label: "5 - 10 Million", min: 5_000_000, max: 10_000_000 },
  { label: "10 - 20 Million", min: 10_000_000, max: 20_000_000 },
  { label: "20 - 50 Million", min: 20_000_000, max: 50_000_000 },
  { label: "50 - 100 Million", min: 50_000_000, max: 100_000_000 },
  { label: "100 - 500 Million", min: 100_000_000, max: 500_000_000 },
  { label: "500 Million - 1 Billion", min: 500_000_000, max: 1_000_000_000 },
  { label: ">1 Billion", min: 1_000_000_000, max: null },
];

export const US_STATES: ReadonlySet<string> = new Set([
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware",
  "district of columbia", "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas",
  "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan", "minnesota", "mississippi",
  "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey", "new mexico", "new york",
  "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania", "rhode island",
  "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont", "virginia", "washington",
  "west virginia", "wisconsin", "wyoming",
]);

// Country names: every ISO region Node knows, by its English display name, plus
// the aliases Apollo location strings use.
const COUNTRY_BY_NAME: Map<string, string> = (() => {
  const map = new Map<string, string>();
  const names = new Intl.DisplayNames(["en"], { type: "region" });
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      let name: string | undefined;
      try {
        name = names.of(code);
      } catch {
        continue;
      }
      if (name && name !== code) map.set(name.toLowerCase(), name);
    }
  }
  const alias: Record<string, string> = {
    us: "United States", usa: "United States", "united states of america": "United States", america: "United States",
    uk: "United Kingdom", gb: "United Kingdom", "great britain": "United Kingdom", england: "United Kingdom",
    uae: "United Arab Emirates",
  };
  for (const [k, v] of Object.entries(alias)) map.set(k, v);
  return map;
})();

/** Canonical English country name for an Apollo/LinkedIn country token, or null. */
export function canonicalCountry(token: string): string | null {
  return COUNTRY_BY_NAME.get(token.trim().toLowerCase()) ?? null;
}

// ─── Plan: Apollo filters → QuickEnrich body + post-filter ─────────────────

/** One Apollo person location, as a structural constraint. Lower-cased. */
export interface LocationConstraint {
  city?: string;
  region?: string;
  country?: string;
  /** Match `region` against the locality's region component only (a US state). */
  regionIsUsState?: boolean;
  /** The token sent server-side as a `locality` substring (narrows the walk). */
  token: string;
}

export interface QuickenrichPlan {
  /** Request body sent to QuickEnrich (without cursor / per_page). */
  body: Record<string, unknown>;
  titles: string[];
  exactTitles: boolean;
  notTitles: string[];
  locations: LocationConstraint[];
  employeeBands: string[];
  revenueBands: string[];
}

export type PlanResult = { ok: true; plan: QuickenrichPlan } | { ok: false; reasons: string[] };

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined || v === "" || v === false) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).every((x) => x === null || x === undefined);
  return false;
}

// Every spelling a stored audience uses (Apollo-native snake_case, and the
// public camelCase aliases) for the fields this source can enforce.
const FIELD_ALIASES: Record<string, string[]> = {
  titles: ["person_titles", "personTitles"],
  notTitles: ["person_not_titles", "personNotTitles"],
  similar: ["include_similar_titles", "includeSimilarTitles"],
  locations: ["person_locations", "personLocations"],
  employees: ["organization_num_employees_ranges", "organizationNumEmployeesRanges"],
  revenue: ["revenue_range", "revenueRangeNative", "revenueRange"],
  // Apollo's own "verified email only" — our search always asks for rows that
  // have an email, and every found address is verified before it is served.
  emailStatus: ["contact_email_status", "contactEmailStatus"],
};
const SUPPORTED_KEYS = new Set(Object.values(FIELD_ALIASES).flat());

function pick(filters: Record<string, unknown>, field: keyof typeof FIELD_ALIASES): unknown {
  for (const k of FIELD_ALIASES[field]) if (!isEmpty(filters[k])) return filters[k];
  return undefined;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : [];
}

/** Parse one Apollo `person_locations` entry; null when it cannot be enforced exactly. */
export function parseApolloLocation(raw: string): LocationConstraint | null {
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const last = parts[parts.length - 1];
  const country = canonicalCountry(last);
  if (parts.length === 1) {
    if (country) return { country: country.toLowerCase(), token: country };
    if (US_STATES.has(last.toLowerCase())) return { region: last.toLowerCase(), regionIsUsState: true, country: "united states", token: last };
    return null;
  }
  if (!country) return null;
  if (parts.length === 2) {
    const place = parts[0];
    const usState = country === "United States" && US_STATES.has(place.toLowerCase());
    // A US state name matches the REGION only ("Washington, US" must not match
    // the city of Washington, DC); anything else may be a region or a city.
    return { region: place.toLowerCase(), regionIsUsState: usState, country: country.toLowerCase(), token: place };
  }
  if (parts.length === 3) {
    return { city: parts[0].toLowerCase(), region: parts[1].toLowerCase(), country: country.toLowerCase(), token: parts[0] };
  }
  return null;
}

/** Apollo "min,max" employee spans → QuickEnrich bands, or null when the edges don't line up. */
export function employeeBandsFor(ranges: string[]): string[] | null {
  const spans: Array<[number, number | null]> = [];
  for (const r of ranges) {
    const [a, b] = r.split(",").map((s) => s.trim());
    const min = a ? Number(a) : 1;
    const max = b ? Number(b) : null;
    if (!Number.isFinite(min) || (max !== null && !Number.isFinite(max))) return null;
    spans.push([min, max]);
  }
  const labels: string[] = [];
  for (const [min, max] of spans) {
    // Edges within one employee of a band edge are the same boundary (Apollo
    // "1,100" ≈ QuickEnrich "< 5" … "20 - 99"). Anything further is not.
    const first = QE_EMPLOYEE_BANDS.findIndex((band) => Math.abs(band.min - min) <= 1 || (min <= 1 && band.min === 1));
    if (first < 0) return null;
    let last = -1;
    for (let i = first; i < QE_EMPLOYEE_BANDS.length; i++) {
      const band = QE_EMPLOYEE_BANDS[i];
      if (max === null ? band.max === null : band.max !== null && Math.abs(band.max - max) <= 1) {
        last = i;
        break;
      }
    }
    if (last < 0) return null;
    for (let i = first; i <= last; i++) labels.push(QE_EMPLOYEE_BANDS[i].label);
  }
  return [...new Set(labels)];
}

/** Apollo revenue {min,max} (USD) → QuickEnrich bands, or null when the edges don't line up. */
export function revenueBandsFor(range: { min?: number | null; max?: number | null }): string[] | null {
  const min = range.min ?? 0;
  const max = range.max ?? null;
  const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, b * 0.001);
  const first = QE_REVENUE_BANDS.findIndex((band) => close(band.min, min));
  if (first < 0) return null;
  for (let i = first; i < QE_REVENUE_BANDS.length; i++) {
    const band = QE_REVENUE_BANDS[i];
    if (max === null ? band.max === null : band.max !== null && close(band.max, max)) {
      return QE_REVENUE_BANDS.slice(first, i + 1).map((b) => b.label);
    }
  }
  return null;
}

/**
 * Can this audience be served faithfully from QuickEnrich? Returns the request
 * body and the post-filter, or every reason it cannot.
 */
export function planQuickenrich(filters: Record<string, unknown>): PlanResult {
  const reasons: string[] = [];
  for (const [k, v] of Object.entries(filters)) {
    if (!isEmpty(v) && !SUPPORTED_KEYS.has(k)) reasons.push(`${k}: not expressible in QuickEnrich`);
  }

  const titles = strings(pick(filters, "titles"));
  if (titles.length === 0) reasons.push("person_titles: required (QuickEnrich needs a title to search on)");
  const notTitles = strings(pick(filters, "notTitles"));
  // Apollo defaults include_similar_titles to true; false means the exact title.
  const exactTitles = filters.include_similar_titles === false || filters.includeSimilarTitles === false;

  const locations: LocationConstraint[] = [];
  for (const raw of strings(pick(filters, "locations"))) {
    const parsed = parseApolloLocation(raw);
    if (!parsed) reasons.push(`person_locations: "${raw}" cannot be matched exactly`);
    else locations.push(parsed);
  }

  let employeeBands: string[] = [];
  const employees = strings(pick(filters, "employees"));
  if (employees.length > 0) {
    const bands = employeeBandsFor(employees);
    if (!bands) reasons.push(`organization_num_employees_ranges: ${JSON.stringify(employees)} does not line up with QuickEnrich's bands`);
    else employeeBands = bands;
  }

  let revenueBands: string[] = [];
  const revenue = pick(filters, "revenue");
  if (revenue !== undefined) {
    if (typeof revenue !== "object" || Array.isArray(revenue)) {
      reasons.push("revenue_range: only the {min,max} USD form is expressible");
    } else {
      const bands = revenueBandsFor(revenue as { min?: number; max?: number });
      if (!bands) reasons.push(`revenue_range: ${JSON.stringify(revenue)} does not line up with QuickEnrich's bands`);
      else revenueBands = bands;
    }
  }

  if (reasons.length > 0) return { ok: false, reasons };

  const body: Record<string, unknown> = {
    title: { include: titles, exclude: notTitles },
    has_email: true,
  };
  if (locations.length > 0) body.locality = { include: [...new Set(locations.map((l) => l.token))], exclude: [] };
  if (employeeBands.length > 0) body.number_of_employees = { include: employeeBands, exclude: [] };
  if (revenueBands.length > 0) body.revenue = { include: revenueBands, exclude: [] };

  return { ok: true, plan: { body, titles, exactTitles, notTitles, locations, employeeBands, revenueBands } };
}

// ─── Post-filter: the row must satisfy every stated constraint ─────────────

export interface QuickenrichRow {
  emp_id: number | string;
  first_name?: string | null;
  last_name?: string | null;
  title?: string | null;
  employee_linkedin?: string | null;
  has_email?: boolean | null;
  company_url?: string | null;
  company_name?: string | null;
  company_linked?: string | null;
  industry?: string | null;
  revenue?: string | null;
  employee_count?: string | null;
  city?: string | null;
  region_code?: string | null;
  country_code?: string | null;
  locality?: string | null;
  [k: string]: unknown;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word, case-insensitive: "DDS" matches "Dentist, DDS", never "Odds". */
export function titleContains(title: string, term: string): boolean {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(norm(term))}($|[^\\p{L}\\p{N}])`, "u").test(norm(title));
}

/** A LinkedIn location string, as components. Lower-cased; "N/A" → null. */
export function parseLocality(locality: string | null | undefined): { parts: string[]; country: string | null } | null {
  if (!locality) return null;
  const raw = locality.trim();
  if (!raw || /^n\/?a$/i.test(raw)) return null;
  const parts = raw
    .split(",")
    .map((p) => p.trim().replace(/\s+metropolitan area$/i, "").replace(/^greater\s+/i, "").replace(/\s+area$/i, "").toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const country = canonicalCountry(parts[parts.length - 1]);
  return { parts: country ? parts.slice(0, -1) : parts, country: country ? country.toLowerCase() : null };
}

export function locationMatches(loc: LocationConstraint, locality: ReturnType<typeof parseLocality>): boolean {
  if (!locality) return false;
  if (loc.country && locality.country !== loc.country) return false;
  const places = locality.parts;
  if (loc.city) {
    // "City, Region, Country": both must line up.
    return places.length >= 2 && places[0] === loc.city && places[1] === loc.region;
  }
  if (loc.region) {
    if (loc.regionIsUsState) {
      // The state is the component right before the country: "Austin, Texas, US"
      // → texas; "Texas, United States" → texas.
      return places.length >= 1 && places[places.length - 1] === loc.region;
    }
    return places.includes(loc.region);
  }
  return true;
}

export type RowVerdict = { keep: true } | { keep: false; reason: string };

export function rowMatchesPlan(row: QuickenrichRow, plan: QuickenrichPlan): RowVerdict {
  if (!row.employee_linkedin || !/linkedin\.com\/in\//i.test(row.employee_linkedin)) return { keep: false, reason: "no_linkedin" };
  if (!row.first_name?.trim() || !row.last_name?.trim()) return { keep: false, reason: "no_full_name" };
  if (!row.company_url?.trim()) return { keep: false, reason: "no_company_domain" };
  if (row.has_email !== true) return { keep: false, reason: "no_email" };
  const title = row.title ?? "";
  const titleOk = plan.exactTitles
    ? plan.titles.some((t) => norm(t) === norm(title))
    : plan.titles.some((t) => titleContains(title, t));
  if (!titleOk) return { keep: false, reason: "title" };
  if (plan.notTitles.some((t) => titleContains(title, t))) return { keep: false, reason: "not_title" };
  if (plan.locations.length > 0) {
    const locality = parseLocality(row.locality);
    if (!plan.locations.some((l) => locationMatches(l, locality))) return { keep: false, reason: "location" };
  }
  if (plan.employeeBands.length > 0 && !plan.employeeBands.includes(String(row.employee_count ?? ""))) {
    return { keep: false, reason: "employees" };
  }
  if (plan.revenueBands.length > 0 && !plan.revenueBands.includes(String(row.revenue ?? ""))) {
    return { keep: false, reason: "revenue" };
  }
  return { keep: true };
}

// ─── Identity + wire shape ─────────────────────────────────────────────────

export const QUICKENRICH_ID_PREFIX = "qe:";

export function quickenrichPersonId(empId: number | string): string {
  return `${QUICKENRICH_ID_PREFIX}${empId}`;
}

export function parseQuickenrichPersonId(id: string): string | null {
  return id.startsWith(QUICKENRICH_ID_PREFIX) && id.length > QUICKENRICH_ID_PREFIX.length ? id.slice(QUICKENRICH_ID_PREFIX.length) : null;
}

/**
 * The LinkedIn URL in Apollo's own form (`http://www.linkedin.com/in/<slug>`,
 * non-ASCII percent-encoded), so human-service's suppression — which matches
 * the normalized URL — sees a person served from Apollo and the same person
 * found here as ONE key. QuickEnrich returns unicode slugs; Apollo returned
 * `%c3%a9` (406 of 43,139 served rows).
 */
export function canonicalLinkedinUrl(url: string): string {
  const m = url.trim().match(/linkedin\.com(\/.*)$/i);
  if (!m) return url.trim();
  let path = m[1].split(/[?#]/)[0].replace(/\/+$/, "");
  try {
    path = decodeURI(path);
  } catch {
    // already-encoded garbage: keep as is
  }
  return `http://www.linkedin.com${encodeURI(path)}`.toLowerCase();
}

function clean(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" || /^n\/?a$/i.test(s) ? null : s;
}

/**
 * A QuickEnrich row in the Person wire shape /search/next and /enrich serve.
 * Only what QuickEnrich provides; everything else is null. The person's
 * city/state/country are the components of their own LinkedIn `locality`
 * (never the company address).
 */
export function quickenrichToPerson(row: QuickenrichRow, email: { email: string | null; emailStatus: string | null } = { email: null, emailStatus: null }) {
  const firstName = clean(row.first_name);
  const lastName = clean(row.last_name);
  const loc = clean(row.locality)?.split(",").map((p) => p.trim()) ?? [];
  const country = loc.length > 0 ? canonicalCountry(loc[loc.length - 1]) : null;
  const places = country ? loc.slice(0, -1) : loc;
  const companyCountry = clean(row.country_code);
  return {
    id: quickenrichPersonId(row.emp_id),
    firstName,
    lastName,
    name: [firstName, lastName].filter(Boolean).join(" ") || null,
    email: email.email,
    emailStatus: email.emailStatus,
    title: clean(row.title),
    linkedinUrl: row.employee_linkedin ? canonicalLinkedinUrl(row.employee_linkedin) : null,
    photoUrl: null,
    headline: null,
    city: places.length >= 2 ? places[0] : null,
    state: places.length >= 2 ? places[1] : places.length === 1 ? places[0] : null,
    country,
    timeZone: null,
    seniority: null,
    departments: null,
    subdepartments: null,
    functions: null,
    employmentHistory: null,
    organizationId: null,
    organizationName: clean(row.company_name),
    organizationDomain: clean(row.company_url),
    organizationIndustry: clean(row.industry),
    // QuickEnrich serves a BAND ("20 - 99"), not a headcount; not invented.
    organizationSize: null,
    organizationRevenueUsd: null,
    organizationAnnualRevenue: null,
    organizationAnnualRevenuePrinted: clean(row.revenue),
    organizationWebsiteUrl: null,
    organizationLinkedinUrl: clean(row.company_linked),
    organizationCity: clean(row.city),
    organizationState: clean(row.region_code),
    organizationCountry: companyCountry ? (new Intl.DisplayNames(["en"], { type: "region" }).of(companyCountry === "UK" ? "GB" : companyCountry) ?? null) : null,
  };
}
