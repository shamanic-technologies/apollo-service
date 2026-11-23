/**
 * Unmask an Apollo teaser person through FREE sources before paying a reveal
 * (APOLLO-ZERO-COST-1119, owner's idea 2026-11-19: « avec les lettres qu'on a,
 * chercher dans une autre base gratuite »).
 *
 * The free Apollo teaser gives the first name, a last-name MASK ("Ri***n" = the
 * first two letters + *** + the last letter), the title and the employer name;
 * we already resolve the employer's domain for free (`apollo_employer_domains`).
 * Leadsforge, then Dropleads, list that company's people for free; the person is
 * unmasked only when EXACTLY ONE distinct last name matches the first name and
 * the mask. Never a guess between two.
 *
 * Measured 2026-11-19 on 60 people already revealed by Apollo (truth known):
 * 32 unmasked, 32 correct, 0 wrong, 0 ambiguous.
 */

import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { freeSourceSearches } from "../db/schema.js";
import { normalizeEmployerName } from "./teaser-employer-domains.js";
import { namePart } from "./email-pattern.js";
import { errorMessage } from "./db-error.js";
import type { TregMeter } from "./treg-meter.js";
import type { BuyingSignalType } from "./buying-signal-spec.js";
import type { EnrichedPersonLike } from "./buying-signals.js";

/** True when `lastName` fits Apollo's mask (prefix before the stars, suffix after). */
export function maskMatches(mask: string | null | undefined, lastName: string | null | undefined): boolean {
  const m = (mask ?? "").match(/^(.*?)\*+(.*)$/);
  if (!m) return false;
  const head = namePart(m[1]);
  const tail = namePart(m[2]);
  const last = namePart(lastName);
  return last.length > 0 && last.length >= head.length + tail.length && last.startsWith(head) && last.endsWith(tail);
}

export interface UnmaskCandidate {
  firstName: string | null;
  lastName: string | null;
  linkedinUrl: string | null;
}

/** The ONE person whose first name equals and last name fits the mask; null on none or on two different people. */
export function pickUnmasked(candidates: UnmaskCandidate[], firstName: string, mask: string): UnmaskCandidate | null {
  const first = namePart(firstName);
  const fits = candidates.filter((c) => namePart(c.firstName) === first && maskMatches(mask, c.lastName));
  const lastNames = new Set(fits.map((c) => namePart(c.lastName)));
  if (lastNames.size !== 1) return null;
  // Prefer the row that carries a LinkedIn (same person, listed twice).
  return fits.find((c) => c.linkedinUrl) ?? fits[0];
}

export interface TeaserIdentity {
  firstName: string;
  mask: string;
  title: string | null;
  organizationName: string;
  domain: string;
  /** The employer's Apollo organization id, resolved free with its domain (exact single match), or null. */
  apolloOrganizationId: string | null;
}

/** The stored teaser of an Apollo person + its employer's free domain, or null when anything is missing. */
export async function loadTeaserIdentity(apolloPersonId: string): Promise<TeaserIdentity | null> {
  const rows = (await db.execute(sql`
    SELECT t.first_name, t.last_name_obfuscated, t.title, t.organization_name
      FROM apollo_teaser_people t
     WHERE t.apollo_person_id = ${apolloPersonId}
     LIMIT 1`)) as unknown as Array<{ first_name: string | null; last_name_obfuscated: string | null; title: string | null; organization_name: string }>;
  const t = rows[0];
  if (!t?.first_name || !t.last_name_obfuscated || !t.organization_name) return null;
  const key = normalizeEmployerName(t.organization_name);
  const dom = (await db.execute(sql`SELECT domain, apollo_organization_id FROM apollo_employer_domains WHERE organization_name_key = ${key} AND domain IS NOT NULL LIMIT 1`)) as unknown as Array<{ domain: string; apollo_organization_id: string | null }>;
  if (!dom[0]?.domain) return null;
  return {
    firstName: t.first_name,
    mask: t.last_name_obfuscated,
    title: t.title,
    organizationName: t.organization_name,
    domain: dom[0].domain,
    apolloOrganizationId: dom[0].apollo_organization_id ?? null,
  };
}

/** The buying signal whose cohort served this person to this org (latest serve), or null. */
export async function servedSignalType(orgId: string, apolloPersonId: string): Promise<BuyingSignalType | null> {
  const rows = (await db.execute(sql`
    SELECT signal->>'type' AS type FROM apollo_signal_serves
     WHERE org_id = ${orgId} AND apollo_person_id = ${apolloPersonId}
     ORDER BY served_at DESC LIMIT 1`)) as unknown as Array<{ type: string | null }>;
  return rows.length > 0 ? ((rows[0].type ?? "unknown") as BuyingSignalType) : null;
}

/**
 * Can the FREE unmask serve a person of this buying signal (APOLLO-ETHAN-1123)?
 * The evidence of a COMPANY signal is about the employer, not the person, so it
 * is read without Apollo's person record: hiring from the employer's job
 * postings (its Apollo org id is resolved free with its domain), funding from
 * the funding our earlier reveals stocked for that company. A job change is the
 * start date of the person's current title, which only Apollo's person record
 * holds: that person stays on the Apollo reveal. An unknown type stays there too.
 */
export function freePathCarriesSignal(type: BuyingSignalType | null): boolean {
  return type === null || type === "hiring" || type === "funding";
}

/**
 * The employer facts a company signal's evidence reads, without Apollo's person
 * record: the org id (free, from the teaser's employer lookup, else from our
 * stock) and the funding our latest reveal at that domain holds for THAT org.
 * Null when no org id is known (no evidence can be dated, never invented).
 */
export async function companyEvidencePerson(apolloPersonId: string, teaser: TeaserIdentity): Promise<EnrichedPersonLike | null> {
  const rows = (await db.execute(sql`
    SELECT organization_id, organization_funding_events, organization_latest_funding_round_date, organization_latest_funding_stage
      FROM apollo_people_enrichments
     WHERE lower(organization_domain) = lower(${teaser.domain}) AND organization_id IS NOT NULL
     ORDER BY (organization_id = ${teaser.apolloOrganizationId ?? ""}) DESC, created_at DESC
     LIMIT 1`)) as unknown as Array<{
    organization_id: string;
    organization_funding_events: unknown;
    organization_latest_funding_round_date: string | null;
    organization_latest_funding_stage: string | null;
  }>;
  return evidencePersonFrom(apolloPersonId, teaser, rows[0] ?? null);
}

/** Pure half of `companyEvidencePerson`: stocked funding is used only when it belongs to the chosen org. */
export function evidencePersonFrom(
  apolloPersonId: string,
  teaser: Pick<TeaserIdentity, "organizationName" | "title" | "apolloOrganizationId">,
  stock: { organization_id: string; organization_funding_events: unknown; organization_latest_funding_round_date: string | null; organization_latest_funding_stage: string | null } | null
): EnrichedPersonLike | null {
  const orgId = teaser.apolloOrganizationId ?? stock?.organization_id ?? null;
  if (!orgId) return null;
  const funding = stock && stock.organization_id === orgId ? stock : null;
  return {
    id: apolloPersonId,
    organizationId: orgId,
    organizationName: teaser.organizationName,
    title: teaser.title,
    employmentHistory: null,
    organizationFundingEvents: funding?.organization_funding_events ?? null,
    organizationLatestFundingRoundDate: funding?.organization_latest_funding_round_date ?? null,
    organizationLatestFundingStage: funding?.organization_latest_funding_stage ?? null,
  };
}

async function freeCall(
  endpoint: "leadsforge.people.search" | "dropleads.people.search",
  body: Record<string, unknown>,
  meter: TregMeter,
  bronze: { orgId: string; runId?: string; campaignId?: string }
): Promise<Record<string, any> | null> {
  const started = Date.now();
  let httpStatus: number | null = null;
  let responseBody: unknown = null;
  let chargedMicro: number | null = null;
  let error: string | null = null;
  try {
    // Metered (src/lib/treg-meter.ts): Leadsforge bills $0.005 per search since 2026-11-20.
    const answer = await meter.post(endpoint, body, { timeoutMs: 30_000 });
    httpStatus = answer.status;
    responseBody = answer.body;
    chargedMicro = answer.chargedMicro;
    if (answer.status !== 200) throw new Error(`HTTP ${answer.status} - ${JSON.stringify(answer.body).slice(0, 300)}`);
    return responseBody as Record<string, any>;
  } catch (err) {
    // A failed free source only means "not unmasked": the caller goes on to the next path.
    error = errorMessage(err);
    console.warn(`[Apollo Service][unmask] ${endpoint} failed: ${error}`);
    return null;
  } finally {
    await db.insert(freeSourceSearches).values({
      orgId: bronze.orgId,
      runId: bronze.runId,
      campaignId: bronze.campaignId,
      source: endpoint.split(".")[0],
      requestBody: body,
      httpStatus,
      responseBody: responseBody as object | null,
      chargedMicro,
      rowsReturned: null,
      error,
      durationMs: Date.now() - started,
    });
  }
}

export interface Unmasked {
  firstName: string;
  lastName: string;
  linkedinUrl: string | null;
  domain: string;
  title: string | null;
  organizationName: string;
  via: "leadsforge" | "dropleads";
}

/** Leadsforge, then Dropleads, by the employer's domain; the ONE matching person, or null. */
export async function unmaskApolloPerson(
  teaser: TeaserIdentity,
  meter: TregMeter,
  bronze: { orgId: string; runId?: string; campaignId?: string }
): Promise<Unmasked | null> {
  const lf = await freeCall("leadsforge.people.search", { companyDomains: { include: [teaser.domain] }, limit: 100 }, meter, bronze);
  const lfRows: UnmaskCandidate[] = Array.isArray(lf?.leads)
    ? lf!.leads.map((l: any) => ({ firstName: l.firstName ?? null, lastName: l.lastName ?? null, linkedinUrl: l.linkedinUrl ?? null }))
    : [];
  let hit = pickUnmasked(lfRows, teaser.firstName, teaser.mask);
  let via: Unmasked["via"] = "leadsforge";
  if (!hit) {
    const dl = await freeCall("dropleads.people.search", { filters: { companyDomains: [teaser.domain] }, pagination: { page: 1, limit: 50 } }, meter, bronze);
    const dlRows: UnmaskCandidate[] = Array.isArray(dl?.data?.leads)
      ? dl!.data.leads.map((l: any) => ({ firstName: l.firstName ?? null, lastName: l.lastName ?? null, linkedinUrl: l.linkedinUrl ?? null }))
      : [];
    hit = pickUnmasked(dlRows, teaser.firstName, teaser.mask);
    via = "dropleads";
  }
  if (!hit?.firstName || !hit.lastName) return null;
  return { firstName: hit.firstName, lastName: hit.lastName, linkedinUrl: hit.linkedinUrl, domain: teaser.domain, title: teaser.title, organizationName: teaser.organizationName, via };
}

/** The Person wire shape for an unmasked Apollo person (same keys as a reveal; absent = null, never invented). */
export function unmaskedToPerson(apolloPersonId: string, u: Unmasked, email: { email: string; emailStatus: string | null }) {
  return {
    id: apolloPersonId,
    firstName: u.firstName,
    lastName: u.lastName,
    name: `${u.firstName} ${u.lastName}`,
    email: email.email,
    emailStatus: email.emailStatus,
    title: u.title,
    linkedinUrl: u.linkedinUrl,
    photoUrl: null,
    headline: null,
    city: null,
    state: null,
    country: null,
    timeZone: null,
    seniority: null,
    departments: null,
    subdepartments: null,
    functions: null,
    employmentHistory: null,
    organizationId: null,
    organizationName: u.organizationName,
    organizationDomain: u.domain,
    organizationIndustry: null,
    organizationSize: null as string | null,
    organizationRevenueUsd: null as number | null,
    organizationAnnualRevenue: null,
    organizationAnnualRevenuePrinted: null,
    organizationWebsiteUrl: `https://${u.domain}`,
    organizationLinkedinUrl: null,
    organizationCity: null,
    organizationState: null,
    organizationCountry: null,
  };
}
