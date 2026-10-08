/**
 * Employer domain on FREE teasers — so a caller can qualify a person's COMPANY
 * before buying the reveal.
 *
 * Apollo's free People Search teaser carries `organization.name` but masks the
 * domain. A consumer that wants to check the company (site speed, hiring,
 * LinkedIn activity...) before paying ~12¢ for /enrich needs that domain at
 * teaser time. We already resolve an employer name to its organization for free
 * in the reveal domain gate; this module does the same lookup at /search/next
 * time and hands the domain back on the teaser's existing `organizationDomain`.
 *
 * RULE (same as the reveal gate): positive evidence only. Apollo's FREE
 * organization name lookup (`organizations/search` in fuzzy_select_mode, 0
 * credits over 101 calls measured 2026-09-29) must return EXACTLY ONE
 * organization id whose name equals the employer name (case/space-insensitive).
 * No exact match, several exact matches, or no domain on the match ⟹ no domain.
 * Never a fuzzy guess, never a default.
 *
 * COST + LATENCY: every outcome (including the negative ones) is cached per
 * normalized name in `apollo_employer_domains` for CACHE_DAYS, so a name is
 * looked up once a month at most, whoever searched. Cache misses are looked up
 * in parallel (LOOKUP_CONCURRENCY) under a wall-clock budget (BUDGET_MS): what
 * resolves in time goes on this page, the rest keeps running in the background
 * and fills the cache for the next page. A failed lookup (Apollo error, rate
 * limit) is NOT cached and simply leaves the domain absent: the domain is
 * additive information, never a reason to fail a search.
 *
 * QUOTA: the lookup's 400/hour cap is shared with the PAID reveal gate. These
 * lookups run at "background" priority (org-lookup-budget.ts): a capped share
 * of the hour, no 429 retries, a pause after any 429, and the rest of the page
 * stops looking up at the first refusal. A customer's /enrich never dies on a
 * quota this fill spent (2026-10-08, Shockwave).
 */

import { and, gt, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { apolloEmployerDomains } from "../db/schema.js";
import { ApolloRateLimitedError, lookupOrganizationsByName, type ApolloOrganizationCandidate } from "./apollo-client.js";
import type { CreditAlertIdentity } from "./credit-alert.js";

export const CACHE_DAYS = 30;
export const LOOKUP_CONCURRENCY = 8;
export const BUDGET_MS = 4000;
const LOOKUP_PER_PAGE = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

export function normalizeEmployerName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export function normalizeDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0].replace(/^www\./, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : null;
}

/** Distinct ids of the candidates whose name equals `name` exactly (normalized). */
export function exactOrganizationIds(name: string, candidates: ApolloOrganizationCandidate[]): string[] {
  const key = normalizeEmployerName(name);
  return [...new Set(candidates.filter((c) => typeof c.id === "string" && c.name && normalizeEmployerName(c.name) === key).map((c) => c.id))];
}

export type EmployerResolution =
  | { outcome: "resolved"; organizationId: string; domain: string }
  | { outcome: "no_domain"; organizationId: string; domain: null }
  | { outcome: "no_exact_match" | "ambiguous"; organizationId: null; domain: null };

/** Pure: exact name to ONE organization with a domain ⟹ that domain; anything else ⟹ null. */
export function resolveEmployer(name: string, candidates: ApolloOrganizationCandidate[]): EmployerResolution {
  const ids = exactOrganizationIds(name, candidates);
  if (ids.length === 0) return { outcome: "no_exact_match", organizationId: null, domain: null };
  if (ids.length > 1) return { outcome: "ambiguous", organizationId: null, domain: null };
  const org = candidates.find((c) => c.id === ids[0])!;
  const domain = normalizeDomain(org.domain) ?? normalizeDomain(org.website_url);
  return domain ? { outcome: "resolved", organizationId: ids[0], domain } : { outcome: "no_domain", organizationId: ids[0], domain: null };
}

export interface CachedResolution {
  key: string;
  domain: string | null;
}

export interface EmployerDomainDeps {
  /** Fresh cache rows for these normalized names (any outcome). */
  readCache(keys: string[]): Promise<CachedResolution[]>;
  writeCache(name: string, resolution: EmployerResolution): Promise<void>;
  lookup(name: string): Promise<ApolloOrganizationCandidate[]>;
  budgetMs?: number;
  concurrency?: number;
}

interface TeaserLike {
  organization?: { name?: string | null; primary_domain?: string | null } | null;
}

/**
 * Domain per normalized employer name, for the employers of `people` that
 * carry no domain already. A name absent from the map (or mapped to null) has
 * no domain. Never throws.
 */
export async function resolveEmployerDomains(people: TeaserLike[], deps: EmployerDomainDeps): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const names = new Map<string, string>();
  for (const p of people) {
    const name = typeof p.organization?.name === "string" ? p.organization.name.trim() : "";
    if (!name || normalizeDomain(p.organization?.primary_domain)) continue;
    const key = normalizeEmployerName(name);
    if (!names.has(key)) names.set(key, name);
  }
  if (names.size === 0) return out;

  try {
    for (const row of await deps.readCache([...names.keys()])) out.set(row.key, row.domain);
  } catch (error) {
    console.error("[Apollo Service][teaser-employer-domains] cache read failed, looking every employer up", error);
  }

  const misses = [...names].filter(([key]) => !out.has(key));
  if (misses.length === 0) return out;

  const found = new Map<string, string | null>();
  let next = 0;
  let rateLimited = false;
  const worker = async () => {
    while (next < misses.length && !rateLimited) {
      const [key, name] = misses[next++];
      try {
        const resolution = resolveEmployer(name, await deps.lookup(name));
        found.set(key, resolution.domain);
        await deps.writeCache(name, resolution);
      } catch (error) {
        // Not cached: the next page retries this name.
        if (error instanceof ApolloRateLimitedError) {
          // Quota shared with the paid reveal gate: stop this page's fill at the first refusal.
          if (!rateLimited) console.warn(`[Apollo Service][teaser-employer-domains] lookups stopped for this page (${misses.length - next + 1} left): ${error.message.slice(0, 200)}`);
          rateLimited = true;
          continue;
        }
        console.warn(`[Apollo Service][teaser-employer-domains] lookup failed for "${name}"`, error instanceof Error ? error.message : error);
      }
    }
  };
  const all = Promise.all(Array.from({ length: Math.min(deps.concurrency ?? LOOKUP_CONCURRENCY, misses.length) }, worker));
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, deps.budgetMs ?? BUDGET_MS);
    timer.unref?.();
  });
  await Promise.race([all, budget]);
  clearTimeout(timer);
  // Lookups still running keep filling the cache for the next page.
  all.catch(() => {});

  for (const [key, domain] of found) out.set(key, domain);
  return out;
}

/** The domain to serve for a teaser's employer, or null. */
export function employerDomainFor(person: TeaserLike, domains: Map<string, string | null>): string | null {
  const name = typeof person.organization?.name === "string" ? person.organization.name.trim() : "";
  if (!name) return null;
  return domains.get(normalizeEmployerName(name)) ?? null;
}

// ─── Production wiring ──────────────────────────────────────────────────────

export function productionEmployerDomainDeps(apiKey: string, alertIdentity?: CreditAlertIdentity): EmployerDomainDeps {
  return {
    readCache: async (keys) => {
      const since = new Date(Date.now() - CACHE_DAYS * DAY_MS);
      const rows = await db
        .select({ key: apolloEmployerDomains.organizationNameKey, domain: apolloEmployerDomains.domain })
        .from(apolloEmployerDomains)
        .where(and(inArray(apolloEmployerDomains.organizationNameKey, keys), gt(apolloEmployerDomains.resolvedAt, since)));
      return rows;
    },
    writeCache: async (name, resolution) => {
      const values = {
        organizationNameKey: normalizeEmployerName(name),
        organizationName: name,
        outcome: resolution.outcome,
        apolloOrganizationId: resolution.organizationId,
        domain: resolution.domain,
        resolvedAt: new Date(),
      };
      await db
        .insert(apolloEmployerDomains)
        .values(values)
        .onConflictDoUpdate({
          target: apolloEmployerDomains.organizationNameKey,
          set: {
            organizationName: values.organizationName,
            outcome: values.outcome,
            apolloOrganizationId: values.apolloOrganizationId,
            domain: values.domain,
            resolvedAt: values.resolvedAt,
          },
        });
    },
    lookup: (name) => lookupOrganizationsByName(apiKey, name, LOOKUP_PER_PAGE, alertIdentity, "background"),
  };
}

/**
 * Production entry for /search/next: employer domains for a page of teasers.
 * Never throws (a domain is additive; the search must not fail for it).
 */
export async function teaserEmployerDomains(
  people: TeaserLike[],
  apiKey: string,
  alertIdentity?: CreditAlertIdentity,
): Promise<Map<string, string | null>> {
  try {
    return await resolveEmployerDomains(people, productionEmployerDomainDeps(apiKey, alertIdentity));
  } catch (error) {
    console.error("[Apollo Service][teaser-employer-domains] failed, serving teasers without employer domains", error);
    return new Map();
  }
}
