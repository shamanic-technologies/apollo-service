/**
 * "Who is the company behind this website, and what does this person do
 * there?" — for a caller with NO org (distribute.you's per-visit Telegram
 * recap, a platform job). Platform-billed, cached, every field independently
 * nullable: "Apollo does not know" is an answer, not an error.
 *
 * SPEND (all measured on prod 2026-10-04 via credit_usage_stats):
 * - company: `GET organizations/enrich?domain=`, 1 lead credit when Apollo
 *   returns an organization, 0 when it knows none.
 * - person: `people/match` by email (+ name + domain), 1 lead credit for a real
 *   match; an unknown address comes back as a synthetic person with
 *   `match_confidence: "none"` for 0 credits.
 * - category: one Jev `choice` judgment on chat-service's platform tier, which
 *   declares its own cost. Never `/complete`.
 *
 * Org-less protocol: a platform run is opened BEFORE the Apollo call (fail
 * loud, nothing spent), the credit is posted as an `actual` platform cost after
 * it, then the run is closed. No org balance exists, so no authorize and no
 * hold. A row whose cost could not be declared is stored with
 * `cost_declared_at` null and declared again under the same idempotency key
 * before it is ever served, so a crash between the call and the declaration
 * never leaves spend untracked and never declares it twice.
 *
 * Cached globally (facts about companies and people, not about who asked):
 * a domain or person looked up once is never paid for again within the TTL.
 */
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { companyDomainLookups, personRoleLookups } from "../db/schema.js";
import { advisoryXactLock } from "./advisory-lock.js";
import {
  enrichOrganizationByDomain,
  matchPersonForRole,
  type ApolloOrganization,
} from "./apollo-client.js";
import { platformChoiceJudgment } from "./chat-client.js";
import { PERSONAL_EMAIL_DOMAINS, normalizeDomain } from "./email-finders.js";
import { decryptPlatformKey } from "./keys-client.js";
import { addPlatformRunCosts, createPlatformRun, updatePlatformRun } from "./runs-client.js";

export const FIRMOGRAPHICS_COST_NAME = "apollo-credit";
const DAY_MS = 24 * 60 * 60 * 1000;
/** A found company / matched person is re-bought after this long. */
export const FOUND_CACHE_DAYS = 90;
/** "Apollo knows nobody here" is re-asked after this long (it cost nothing). */
export const NOT_FOUND_CACHE_DAYS = 30;
/** Below this Jev confidence the category is reported unknown, never guessed. */
export const MIN_CATEGORY_CONFIDENCE = 0.5;

export const BUSINESS_CATEGORIES = ["B2B SaaS", "B2B Agency", "B2C", "Other"] as const;
export type BusinessCategory = (typeof BUSINESS_CATEGORIES)[number];

const CATEGORY_CRITERIA: Record<BusinessCategory, string> = {
  "B2B SaaS": "Sells software (a web app, platform, API or tool) to businesses, usually by subscription.",
  "B2B Agency": "Sells services delivered by people to businesses: marketing, design, development, consulting, recruiting, lead generation, outsourcing.",
  B2C: "Sells mainly to individual consumers: retail, e-commerce, consumer apps, restaurants, personal services, consumer brands.",
  Other: "None of the above: manufacturing, wholesale, finance, healthcare providers, public sector, non-profits, education, or a mix with no dominant model.",
};

const CATEGORY_INSTRUCTIONS =
  "Which business model best describes this company? Judge from what it sells and to whom, using its description, industry and keywords.";

export interface Range {
  label: string;
  min: number;
  /** null for the open-ended top bucket. */
  max: number | null;
}

export interface CompanyAnswer {
  name: string | null;
  domain: string;
  countryCode: string | null;
  countryName: string | null;
  industry: string | null;
  revenueRange: Range | null;
  employeeRange: Range | null;
  category: BusinessCategory | null;
  categoryConfidence: number | null;
  apolloOrganizationId: string | null;
  /** The company's LinkedIn page, verbatim from Apollo (`linkedin_url`). null when Apollo has none. */
  linkedinUrl: string | null;
}

export interface PersonAnswer {
  title: string | null;
  seniority: string | null;
}

export interface FirmographicsAnswer {
  domain: string;
  company: CompanyAnswer | null;
  noCompanyReason: "personal_email_domain" | "not_found" | null;
  person: PersonAnswer | null;
  personMatched: boolean | null;
  cached: { company: boolean | null; person: boolean | null };
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

/** `https://www.Stripe.com/pricing` → `stripe.com`; null when not a domain. */
export function toCompanyDomain(input: string): string | null {
  const d = normalizeDomain(input).replace(/:\d+$/, "").replace(/\.$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : null;
}

export function isPersonalDomain(domain: string): boolean {
  return PERSONAL_EMAIL_DOMAINS.has(domain);
}

const EMPLOYEE_BUCKETS: Array<[number, number | null]> = [
  [1, 10], [11, 50], [51, 200], [201, 500], [501, 1000], [1001, 5000], [5001, 10000], [10001, null],
];

export function employeeRange(n: unknown): Range | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  for (const [min, max] of EMPLOYEE_BUCKETS) {
    if (max === null || n <= max) {
      return { min, max, label: max === null ? `${min.toLocaleString("en-US")}+` : `${min.toLocaleString("en-US")}-${max.toLocaleString("en-US")}` };
    }
  }
  return null;
}

const M = 1_000_000;
const REVENUE_BUCKETS: Array<[number, number | null, string]> = [
  [0, M, "<$1M"],
  [M, 10 * M, "$1M-$10M"],
  [10 * M, 50 * M, "$10M-$50M"],
  [50 * M, 100 * M, "$50M-$100M"],
  [100 * M, 500 * M, "$100M-$500M"],
  [500 * M, 1000 * M, "$500M-$1B"],
  [1000 * M, null, "$1B+"],
];

export function revenueRange(usd: unknown): Range | null {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) return null;
  for (const [min, max, label] of REVENUE_BUCKETS) {
    if (max === null || usd < max) return { min, max, label };
  }
  return null;
}

/** `information technology & services` → `Information Technology & Services`. */
export function humanIndustry(industry: unknown): string | null {
  if (typeof industry !== "string" || !industry.trim()) return null;
  return industry
    .trim()
    .split(/\s+/)
    .map((w) => (w === "&" || w === "and" || w === "of" ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

function countryKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z]/g, "");
}

/** Apollo names that differ from CLDR's English display names. */
const COUNTRY_ALIASES: Record<string, string> = {
  hongkong: "HK", macau: "MO", macao: "MO", czechrepublic: "CZ", turkey: "TR", turkiye: "TR",
  ivorycoast: "CI", cotedivoire: "CI", myanmar: "MM", burma: "MM", russianfederation: "RU",
  republicofkorea: "KR", korea: "KR", northkorea: "KP", usa: "US", unitedstatesofamerica: "US", uk: "GB",
  england: "GB", scotland: "GB", wales: "GB", northernireland: "GB", greatbritain: "GB",
  democraticrepublicofthecongo: "CD", republicofthecongo: "CG", congo: "CG", macedonia: "MK",
  swaziland: "SZ", palestine: "PS", bosniaandherzegovina: "BA", vatican: "VA", vaticancity: "VA",
  capeverde: "CV", eastimor: "TL", timorleste: "TL", saintkittsandnevis: "KN", saintlucia: "LC",
  saintvincentandthegrenadines: "VC", micronesia: "FM", curacao: "CW", reunion: "RE",
};

let countryIndex: Map<string, string> | null = null;
function buildCountryIndex(): Map<string, string> {
  const names = new Intl.DisplayNames(["en"], { type: "region" });
  const index = new Map<string, string>();
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const raw = String.fromCharCode(a, b);
      if (raw === "EU" || raw === "EZ" || raw === "UN" || raw.startsWith("Q")) continue; // groupings, not countries
      let name: string | undefined;
      let code: string | undefined;
      try {
        name = names.of(raw);
        // Deprecated aliases (UK, BU, ZR, ...) canonicalize to today's code.
        code = new Intl.Locale(`und-${raw}`).region;
      } catch {
        continue; // not a region code CLDR accepts
      }
      if (!name || !code || name === raw || name === "Unknown Region") continue;
      index.set(countryKey(name), code);
      // "Hong Kong SAR China" → also "hongkong"; "Congo - Kinshasa" stays as is.
      index.set(countryKey(name.replace(/\s+SAR China$/, "").replace(/\s*\(.*\)$/, "")), code);
    }
  }
  for (const [k, code] of Object.entries(COUNTRY_ALIASES)) index.set(k, code);
  return index;
}

/** ISO 3166-1 alpha-2 for Apollo's English country name; null when unknown. */
export function countryCode(name: unknown): string | null {
  if (typeof name !== "string" || !name.trim()) return null;
  countryIndex ??= buildCountryIndex();
  return countryIndex.get(countryKey(name)) ?? null;
}

/** The text Jev judges: only what Apollo said about the company. Null when it said nothing usable. */
export function categoryState(org: Partial<ApolloOrganization> & { keywords?: unknown; industries?: unknown }): Record<string, unknown> | null {
  const description = typeof org.short_description === "string" && org.short_description.trim() ? org.short_description.trim() : null;
  const keywords = Array.isArray(org.keywords) ? org.keywords.filter((k): k is string => typeof k === "string").slice(0, 25) : [];
  const industry = typeof org.industry === "string" && org.industry.trim() ? org.industry.trim() : null;
  if (!description && keywords.length === 0 && !industry) return null;
  return {
    name: org.name ?? null,
    industry,
    ...(Array.isArray(org.industries) && { industries: org.industries }),
    description,
    keywords,
  };
}

export function toCompanyAnswer(domain: string, row: {
  apolloOrganizationId: string | null;
  raw: unknown;
  category: string | null;
  categoryConfidence: string | number | null;
}): CompanyAnswer {
  const o = (row.raw ?? {}) as Partial<ApolloOrganization>;
  const confidence = row.categoryConfidence === null ? null : Number(row.categoryConfidence);
  const category =
    row.category && (BUSINESS_CATEGORIES as readonly string[]).includes(row.category) && confidence !== null && confidence >= MIN_CATEGORY_CONFIDENCE
      ? (row.category as BusinessCategory)
      : null;
  return {
    name: typeof o.name === "string" && o.name.trim() ? o.name.trim() : null,
    domain: typeof o.primary_domain === "string" && o.primary_domain ? o.primary_domain : domain,
    countryCode: countryCode(o.country),
    countryName: typeof o.country === "string" && o.country.trim() ? o.country.trim() : null,
    industry: humanIndustry(o.industry),
    revenueRange: revenueRange(o.annual_revenue),
    employeeRange: employeeRange(o.estimated_num_employees),
    category,
    categoryConfidence: confidence,
    apolloOrganizationId: row.apolloOrganizationId,
    linkedinUrl: typeof o.linkedin_url === "string" && o.linkedin_url.trim() ? o.linkedin_url.trim() : null,
  };
}

/** Cache key for a person: the email when given, else name at domain. */
export function personKey(args: { email?: string; firstName?: string; lastName?: string; domain: string }): string | null {
  const email = args.email?.trim().toLowerCase();
  if (email) return `email:${email}`;
  const first = args.firstName?.trim().toLowerCase();
  const last = args.lastName?.trim().toLowerCase();
  if (first && last) return `name:${first}|${last}@${args.domain}`;
  return null;
}

// ─── Spend (org-less) ────────────────────────────────────────────────────────

async function declareCredits(runId: string, credits: number, idempotencyKey: string): Promise<void> {
  if (credits > 0) {
    await addPlatformRunCosts(runId, [{ costName: FIRMOGRAPHICS_COST_NAME, quantity: credits, idempotencyKey }]);
  }
  await updatePlatformRun(runId, "completed");
}

/** Open a platform run, run the paid call, return its run id. Marks the run failed if the call throws. */
async function onPlatformRun<T>(taskName: string, key: string, call: (runId: string) => Promise<T>): Promise<{ runId: string; result: T }> {
  const run = await createPlatformRun({ taskName, idempotencyKey: `apollo-service:${taskName}:${key}:${Date.now()}` });
  try {
    return { runId: run.id, result: await call(run.id) };
  } catch (err) {
    await updatePlatformRun(run.id, "failed").catch((e) =>
      console.error(`[Apollo Service][${taskName}] platform run.mark_failed_failed run=${run.id}`, e),
    );
    throw err;
  }
}

function platformApolloKey(): Promise<string> {
  return decryptPlatformKey("apollo", { callerMethod: "POST", callerPath: "/internal/company-firmographics" });
}

// ─── Company ─────────────────────────────────────────────────────────────────

type CompanyRow = typeof companyDomainLookups.$inferSelect;

function isFresh(fetchedAt: Date, found: boolean): boolean {
  const days = found ? FOUND_CACHE_DAYS : NOT_FOUND_CACHE_DAYS;
  return Date.now() - fetchedAt.getTime() < days * DAY_MS;
}

async function lookupCompanyRow(domain: string, getKey: () => Promise<string>): Promise<{ row: CompanyRow; cached: boolean }> {
  return db.transaction(async (tx) => {
    await advisoryXactLock(tx, `company-firmographics:${domain}`);
    const [existing] = await tx.select().from(companyDomainLookups).where(eq(companyDomainLookups.domain, domain)).limit(1);

    if (existing && isFresh(existing.fetchedAt, existing.raw !== null)) return { row: existing, cached: true };

    const apiKey = await getKey();
    const { runId, result: org } = await onPlatformRun("company-firmographics", domain, () => enrichOrganizationByDomain(apiKey, domain));
    const values = {
      domain,
      apolloOrganizationId: typeof org?.id === "string" ? org.id : null,
      raw: org ?? null,
      fetchedAt: new Date(),
      platformRunId: runId,
      creditsCharged: org ? 1 : 0,
      costIdempotencyKey: `apollo-service:company-firmographics:${runId}`,
      costDeclaredAt: null,
      category: null,
      categoryConfidence: null,
      categoryJudgment: null,
      categoryJudgedAt: null,
    };
    const [row] = await tx
      .insert(companyDomainLookups)
      .values(values)
      .onConflictDoUpdate({ target: companyDomainLookups.domain, set: values })
      .returning();
    return { row, cached: false };
  });
}

/**
 * Declare a stored lookup's platform cost if it is not declared yet. Runs AFTER
 * the row committed: a failure here leaves the row undeclared (and the request
 * failing loud), and the next request declares it under the same idempotency
 * key instead of paying Apollo again. Two concurrent declarers are harmless:
 * runs-service replays the original cost row for a repeated key.
 */
async function settleCompanyCost(row: CompanyRow): Promise<CompanyRow> {
  if (row.costDeclaredAt) return row;
  await declareCredits(row.platformRunId, row.creditsCharged, row.costIdempotencyKey);
  const [settled] = await db
    .update(companyDomainLookups)
    .set({ costDeclaredAt: new Date() })
    .where(eq(companyDomainLookups.domain, row.domain))
    .returning();
  return settled;
}

async function ensureCategory(row: CompanyRow): Promise<CompanyRow> {
  if (row.raw === null || row.categoryJudgedAt) return row;
  const state = categoryState(row.raw as Partial<ApolloOrganization>);
  if (!state) {
    const [updated] = await db
      .update(companyDomainLookups)
      .set({ categoryJudgedAt: new Date() })
      .where(eq(companyDomainLookups.domain, row.domain))
      .returning();
    return updated;
  }
  const answer = await platformChoiceJudgment({ state, instructions: CATEGORY_INSTRUCTIONS, criteria: CATEGORY_CRITERIA });
  const [updated] = await db
    .update(companyDomainLookups)
    .set({
      category: answer.choice,
      categoryConfidence: String(answer.confidence),
      categoryJudgment: answer,
      categoryJudgedAt: new Date(),
    })
    .where(eq(companyDomainLookups.domain, row.domain))
    .returning();
  return updated;
}

// ─── Person ──────────────────────────────────────────────────────────────────

type PersonRow = typeof personRoleLookups.$inferSelect;

async function lookupPersonRow(
  key: string,
  args: { email?: string; firstName?: string; lastName?: string; domain: string },
  getKey: () => Promise<string>,
): Promise<{ row: PersonRow; cached: boolean }> {
  return db.transaction(async (tx) => {
    await advisoryXactLock(tx, `person-role:${key}`);
    const [existing] = await tx.select().from(personRoleLookups).where(eq(personRoleLookups.personKey, key)).limit(1);

    if (existing && isFresh(existing.fetchedAt, existing.matched)) return { row: existing, cached: true };

    const apiKey = await getKey();
    const { runId, result: person } = await onPlatformRun("person-role", key, () =>
      // A free-mail domain names no employer: sending it would only mislead the
      // match. (Firmographics never reaches here for one; person-identity does.)
      matchPersonForRole(apiKey, {
        email: args.email,
        firstName: args.firstName,
        lastName: args.lastName,
        domain: isPersonalDomain(args.domain) ? undefined : args.domain,
      }),
    );
    const matched = !!person && person.match_confidence !== "none";
    const values = {
      personKey: key,
      domain: args.domain,
      matched,
      title: matched && typeof person?.title === "string" && person.title.trim() ? person.title.trim() : null,
      seniority: matched && typeof person?.seniority === "string" && person.seniority.trim() ? person.seniority.trim() : null,
      raw: person ?? null,
      fetchedAt: new Date(),
      platformRunId: runId,
      creditsCharged: matched ? 1 : 0,
      costIdempotencyKey: `apollo-service:person-role:${runId}`,
      costDeclaredAt: null,
    };
    const [row] = await tx
      .insert(personRoleLookups)
      .values(values)
      .onConflictDoUpdate({ target: personRoleLookups.personKey, set: values })
      .returning();
    return { row, cached: false };
  });
}

async function settlePersonCost(row: PersonRow): Promise<PersonRow> {
  if (row.costDeclaredAt) return row;
  await declareCredits(row.platformRunId, row.creditsCharged, row.costIdempotencyKey);
  const [settled] = await db
    .update(personRoleLookups)
    .set({ costDeclaredAt: new Date() })
    .where(eq(personRoleLookups.personKey, row.personKey))
    .returning();
  return settled;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function lookupFirmographics(input: {
  domain: string;
  email?: string;
  firstName?: string;
  lastName?: string;
}): Promise<FirmographicsAnswer> {
  const domain = input.domain;
  if (isPersonalDomain(domain)) {
    return { domain, company: null, noCompanyReason: "personal_email_domain", person: null, personMatched: null, cached: { company: null, person: null } };
  }

  let key: Promise<string> | null = null;
  const getKey = () => (key ??= platformApolloKey());

  const pKey = personKey({ ...input, domain });
  const [companyLookup, personLookup] = await Promise.all([
    lookupCompanyRow(domain, getKey).then(async (r) => ({ row: await ensureCategory(await settleCompanyCost(r.row)), cached: r.cached })),
    pKey
      ? lookupPersonRow(pKey, { ...input, domain }, getKey).then(async (r) => ({ row: await settlePersonCost(r.row), cached: r.cached }))
      : Promise.resolve(null),
  ]);

  const company = companyLookup.row.raw === null ? null : toCompanyAnswer(domain, companyLookup.row);
  return {
    domain,
    company,
    noCompanyReason: company ? null : "not_found",
    person: personLookup?.row.matched ? { title: personLookup.row.title, seniority: personLookup.row.seniority } : null,
    personMatched: personLookup ? personLookup.row.matched : null,
    cached: { company: companyLookup.cached, person: personLookup ? personLookup.cached : null },
  };
}

// ─── Person identity by email ────────────────────────────────────────────────

export interface PersonIdentityAnswer {
  /** The email that was looked up, lower-cased. */
  email: string;
  /** Apollo matched a real person (match_confidence present and not "none"). */
  matched: boolean;
  /** Apollo's own match_confidence ("high" | "low" | "none" | ...), verbatim. null when Apollo sent none. */
  matchConfidence: string | null;
  /** The matched person's LinkedIn profile URL, verbatim from Apollo. null when not matched or Apollo has none. */
  linkedinUrl: string | null;
  apolloPersonId: string | null;
  name: string | null;
  cached: boolean;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * "Who is the person behind this email?" (their LinkedIn profile, mainly), for
 * an org-less caller (client-service resolving one of our own users). Apollo
 * `people/match` by EMAIL only: never by name, a name is not a person. Shares the
 * `person_role_lookups` cache and its spend protocol with the firmographics
 * person leg (1 apollo-credit when matched, 0 otherwise, platform run, declared
 * before serving), so a person already looked up there is not paid twice.
 */
export async function lookupPersonIdentity(rawEmail: string): Promise<PersonIdentityAnswer> {
  const email = rawEmail.trim().toLowerCase();
  const domain = email.slice(email.lastIndexOf("@") + 1);
  let key: Promise<string> | null = null;
  const getKey = () => (key ??= decryptPlatformKey("apollo", { callerMethod: "POST", callerPath: "/internal/person-identity" }));
  const lookup = await lookupPersonRow(`email:${email}`, { email, domain }, getKey);
  const row = await settlePersonCost(lookup.row);
  const p = (row.raw ?? {}) as Record<string, unknown>;
  return {
    email,
    matched: row.matched,
    matchConfidence: str(p.match_confidence),
    linkedinUrl: row.matched ? str(p.linkedin_url) : null,
    apolloPersonId: row.matched ? str(p.id) : null,
    name: row.matched ? str(p.name) : null,
    cached: lookup.cached,
  };
}
