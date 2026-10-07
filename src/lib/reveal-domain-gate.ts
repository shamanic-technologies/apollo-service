/**
 * Reveal domain gate — do not buy an Apollo reveal whose address cannot pass
 * the deliverability gate.
 *
 * Only a `valid` BounceVerify verdict is served (email-verification.ts). Two of
 * the non-valid verdicts are properties of the MAIL DOMAIN, not of the person:
 *
 *   catch_all — the domain accepts every address, so no address on it can ever
 *               be confirmed. Every reveal on that domain is a credit thrown away.
 *   unknown   — the domain's mail server refuses our checker (port 25 closed,
 *               550 policy block, HELO rejected, probe timeout). Every address
 *               on it comes back unknown too.
 *
 * Measured on prod 2026-09-25..29 (1,328 reveals with a verdict): a domain that
 * already carried a catch_all verdict produced 132 more catch_alls and ZERO
 * valids; one that carried an unknown produced 121 more unknowns and ZERO valids.
 * An Apollo reveal costs 11.8¢ (org price), a BounceVerify check 0.445¢ (and 0
 * when it answers unknown), so learning the domain first costs ~1/26 of the
 * reveal it can save.
 *
 * FLOW, per /enrich of an Apollo person, BEFORE any credit is spent:
 *   1. Employer name: the free teaser /search/next served (`apollo_teaser_people`).
 *   2. Organization: Apollo's FREE name lookup; resolved only on an exact name
 *      match to ONE organization id (never a fuzzy guess).
 *   3. Candidate mail domains: the organization's own domain, plus every email
 *      domain we already revealed at that organization id (the real mail domain
 *      when it differs from the website).
 *   4. Judge each domain from what the WHOLE fleet already verified on it
 *      (email_verifications, any org, any source); a domain nobody verified yet
 *      is PROBED with one random address at it (billed like any verification).
 *   5. SKIP the reveal only when EVERY candidate domain is bad. Anything short
 *      of positive evidence (no employer, ambiguous name, no domain) reveals as
 *      before — the benefit of the doubt goes to the lead.
 *
 * A checker block is not a permanent fact about a domain: an `unknown` condemns
 * it for CHECKER_BLOCKED_TTL_DAYS only, then the next reveal re-probes (free
 * when it still answers unknown). The latest decisive verdict wins among the
 * decisive ones; it also wins over unknowns UNLESS at least
 * BLOCK_RUN_AFTER_DECISIVE unknowns came after it (2026-10-07: jumptrading.com
 * gave 370 unknowns — Proofpoint 554 on our checker — and ONE valid; that
 * single valid kept the domain "ok" for 30 days and paid 256 more reveals).
 *
 * A PROBE answering `valid` means the domain accepted a random mailbox nobody
 * owns: that is a catch-all domain whatever the checker calls it.
 *
 * An AMBIGUOUS employer name (several Apollo organizations carry it exactly) is
 * judged across EVERY candidate's domains: whichever of them employs the
 * person, the reveal is skipped only when all of them are bad, so the benefit
 * of the doubt still holds. Measured 2026-10-02..07: ambiguous names were 56% of
 * the gate-passes that ended catch-all/unknown, the domain-judged path ~12%.
 *
 * Every skip is written to `reveal_skips` with its evidence and returned to the
 * caller as `revealSkipped`; nothing is skipped silently.
 */

import { randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { apolloPeopleEnrichments, apolloTeaserPeople, emailVerifications, revealSkips } from "../db/schema.js";
import { lookupOrganizationsByName, type ApolloOrganizationCandidate } from "./apollo-client.js";
import type { CreditAlertIdentity } from "./credit-alert.js";
import { exactOrganizationIds, normalizeDomain } from "./teaser-employer-domains.js";
import { verifyRevealedEmail, VERDICT_REUSE_DAYS, type EmailVerdict, type VerificationContext } from "./email-verification.js";

/** A catch-all verdict condemns its domain as long as a verdict is reused at all. */
export const CATCH_ALL_TTL_DAYS = VERDICT_REUSE_DAYS;
/** A checker block (unknown) is transient: re-probed after this. */
export const CHECKER_BLOCKED_TTL_DAYS = 7;
/** Unknowns needed AFTER the latest decisive verdict to overturn it (one transient timeout is not a block). */
export const BLOCK_RUN_AFTER_DECISIVE = 2;
/** The verification source a gate probe is recorded under. */
export const PROBE_SOURCE = "reveal-domain-probe";
const LOOKUP_PER_PAGE = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface DomainVerdictRow {
  verdict: EmailVerdict;
  verificationId: string;
  verifiedAt: Date;
  /** true = a gate probe (a random address nobody owns), not a real person's address. */
  probe?: boolean;
}

export type DomainJudgement =
  | { state: "bad"; reason: "catch_all_domain" | "checker_blocked_domain"; row: DomainVerdictRow }
  | { state: "ok"; row: DomainVerdictRow }
  | { state: "unknown" };

/**
 * Pure. `rows` = every verdict held for the domain, any order. The latest
 * decisive verdict within CATCH_ALL_TTL_DAYS decides (catch_all, or a probe
 * answering valid → bad; valid, invalid, risky → the domain confirms
 * mailboxes → ok), unless BLOCK_RUN_AFTER_DECISIVE unknowns within
 * CHECKER_BLOCKED_TTL_DAYS came after it (the checker is refused now → bad).
 * With no decisive one, an unknown within CHECKER_BLOCKED_TTL_DAYS → bad.
 * Otherwise nothing is known.
 */
export function judgeDomain(rows: DomainVerdictRow[], now: Date = new Date()): DomainJudgement {
  const age = (r: DomainVerdictRow) => now.getTime() - r.verifiedAt.getTime();
  const latest = (xs: DomainVerdictRow[]) => xs.reduce<DomainVerdictRow | null>((a, r) => (!a || r.verifiedAt > a.verifiedAt ? r : a), null);

  const unknowns = rows.filter((r) => r.verdict === "unknown" && age(r) < CHECKER_BLOCKED_TTL_DAYS * DAY_MS);
  const decisive = latest(rows.filter((r) => r.verdict !== "unknown" && age(r) < CATCH_ALL_TTL_DAYS * DAY_MS));
  if (decisive) {
    const after = unknowns.filter((r) => r.verifiedAt > decisive.verifiedAt);
    if (after.length >= BLOCK_RUN_AFTER_DECISIVE) return { state: "bad", reason: "checker_blocked_domain", row: latest(after)! };
    const acceptsAnything = decisive.verdict === "catch_all" || (decisive.probe === true && decisive.verdict === "valid");
    return acceptsAnything ? { state: "bad", reason: "catch_all_domain", row: decisive } : { state: "ok", row: decisive };
  }
  const blocked = latest(unknowns);
  if (blocked) return { state: "bad", reason: "checker_blocked_domain", row: blocked };
  return { state: "unknown" };
}

// One definition of "exact name to ONE organization", shared with the teaser employer domains.
export { normalizeDomain };

export interface DomainEvidence {
  domain: string;
  verdict: EmailVerdict | null;
  verificationId: string | null;
  verifiedAt: string | null;
  /** true = learned now by probing a random address at the domain. */
  probed: boolean;
}

export type GateDecision =
  | {
      action: "skip";
      reason: "catch_all_domain" | "checker_blocked_domain";
      organizationName: string;
      organizationId: string;
      evidence: DomainEvidence[];
    }
  | {
      action: "reveal";
      /** Why the gate let it through — for the trace, never a silent default. */
      basis: "domain_ok" | "no_employer" | "no_exact_org_match" | "ambiguous_org_name" | "no_domain";
      organizationName?: string;
      organizationId?: string;
      evidence?: DomainEvidence[];
    };

/** Everything the gate reads or calls, so the decision is testable without a DB or Apollo. */
export interface GateDeps {
  employerOf(apolloPersonId: string): Promise<string | null>;
  lookupOrganizations(name: string): Promise<ApolloOrganizationCandidate[]>;
  revealedEmailDomains(organizationId: string): Promise<string[]>;
  domainVerdicts(domain: string): Promise<DomainVerdictRow[]>;
  /** Verify one random address at the domain; returns the stored verdict row. */
  probe(domain: string): Promise<DomainVerdictRow>;
  now?: () => Date;
}

function toEvidence(domain: string, row: DomainVerdictRow | null, probed: boolean): DomainEvidence {
  return {
    domain,
    verdict: row?.verdict ?? null,
    verificationId: row?.verificationId ?? null,
    verifiedAt: row ? row.verifiedAt.toISOString() : null,
    probed,
  };
}

export async function decideReveal(apolloPersonId: string, deps: GateDeps): Promise<GateDecision> {
  const now = deps.now ?? (() => new Date());

  const organizationName = await deps.employerOf(apolloPersonId);
  if (!organizationName) return { action: "reveal", basis: "no_employer" };

  const candidates = await deps.lookupOrganizations(organizationName);
  const exactIds = exactOrganizationIds(organizationName, candidates);
  if (exactIds.length === 0) return { action: "reveal", basis: "no_exact_org_match", organizationName };
  // Several organizations carry the name: the person works at ONE of them, so
  // every candidate's domains are judged and a skip needs all of them bad.
  const organizationId = exactIds.join(",");

  const domains: string[] = [];
  for (const id of exactIds) {
    const org = candidates.find((c) => c.id === id)!;
    domains.push(
      ...[normalizeDomain(org.domain) ?? normalizeDomain(org.website_url), ...(await deps.revealedEmailDomains(id)).map(normalizeDomain)].filter(
        (d): d is string => !!d
      )
    );
  }
  const uniqueDomains = [...new Set(domains)];
  if (uniqueDomains.length === 0) {
    return { action: "reveal", basis: exactIds.length > 1 ? "ambiguous_org_name" : "no_domain", organizationName, organizationId };
  }

  // Known domains first: one known-ok domain lets the reveal through without probing anything.
  const evidence: DomainEvidence[] = [];
  const unjudged: string[] = [];
  let reason: "catch_all_domain" | "checker_blocked_domain" | null = null;
  for (const domain of uniqueDomains) {
    const judged = judgeDomain(await deps.domainVerdicts(domain), now());
    if (judged.state === "ok") {
      return { action: "reveal", basis: "domain_ok", organizationName, organizationId, evidence: [toEvidence(domain, judged.row, false)] };
    }
    if (judged.state === "bad") {
      evidence.push(toEvidence(domain, judged.row, false));
      reason ??= judged.reason;
    } else {
      unjudged.push(domain);
    }
  }

  for (const domain of unjudged) {
    const row = await deps.probe(domain);
    const judged = judgeDomain([row], now());
    if (judged.state !== "bad") {
      return { action: "reveal", basis: "domain_ok", organizationName, organizationId, evidence: [...evidence, toEvidence(domain, row, true)] };
    }
    evidence.push(toEvidence(domain, row, true));
    reason ??= judged.reason;
  }

  return { action: "skip", reason: reason!, organizationName, organizationId, evidence };
}

// ─── Production wiring ──────────────────────────────────────────────────────

export interface GateContext {
  apolloApiKey: string;
  alertIdentity?: CreditAlertIdentity;
  /** The reveal's own verification context: a probe is billed exactly like a reveal's check. */
  verify: VerificationContext;
}

async function employerOf(apolloPersonId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: apolloTeaserPeople.organizationName })
    .from(apolloTeaserPeople)
    .where(eq(apolloTeaserPeople.apolloPersonId, apolloPersonId))
    .limit(1);
  return row?.name ?? null;
}

async function revealedEmailDomains(organizationId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ domain: sql<string>`lower(split_part(${apolloPeopleEnrichments.email}, '@', 2))` })
    .from(apolloPeopleEnrichments)
    .where(and(eq(apolloPeopleEnrichments.organizationId, organizationId), isNotNull(apolloPeopleEnrichments.email)));
  return rows.map((r) => r.domain);
}

async function domainVerdicts(domain: string): Promise<DomainVerdictRow[]> {
  const since = new Date(Date.now() - CATCH_ALL_TTL_DAYS * DAY_MS);
  const rows = await db
    .select({ verdict: emailVerifications.verdict, id: emailVerifications.id, verifiedAt: emailVerifications.verifiedAt, source: emailVerifications.source })
    .from(emailVerifications)
    .where(
      and(
        sql`split_part(${emailVerifications.email}, '@', 2) = ${domain}`,
        isNotNull(emailVerifications.verdict),
        gt(emailVerifications.verifiedAt, since)
      )
    )
    .orderBy(desc(emailVerifications.verifiedAt))
    .limit(50);
  return rows.map((r) => ({ verdict: r.verdict as EmailVerdict, verificationId: r.id, verifiedAt: r.verifiedAt, probe: r.source === PROBE_SOURCE }));
}

export function probeAddress(domain: string): string {
  return `zz-probe-${randomBytes(6).toString("hex")}@${domain}`;
}

export function productionDeps(ctx: GateContext): GateDeps {
  return {
    employerOf,
    lookupOrganizations: (name) => lookupOrganizationsByName(ctx.apolloApiKey, name, LOOKUP_PER_PAGE, ctx.alertIdentity),
    revealedEmailDomains,
    domainVerdicts,
    probe: async (domain) => {
      const result = await verifyRevealedEmail(probeAddress(domain), { ...ctx.verify, source: PROBE_SOURCE });
      return { verdict: result.verdict, verificationId: result.verificationId, verifiedAt: new Date(result.verifiedAt), probe: true };
    },
  };
}

export async function gateReveal(apolloPersonId: string, ctx: GateContext): Promise<GateDecision> {
  return decideReveal(apolloPersonId, productionDeps(ctx));
}

export interface SkipAttribution {
  orgId: string;
  runId: string;
  brandIds?: string[];
  campaignId?: string;
  audienceId?: string;
}

/** Persist a skip with its evidence. Returns the ledger row id. */
export async function recordRevealSkip(
  apolloPersonId: string,
  decision: Extract<GateDecision, { action: "skip" }>,
  who: SkipAttribution
): Promise<string> {
  const [row] = await db
    .insert(revealSkips)
    .values({
      orgId: who.orgId,
      runId: who.runId,
      brandIds: who.brandIds ?? null,
      campaignId: who.campaignId ?? null,
      audienceId: who.audienceId ?? null,
      apolloPersonId,
      organizationName: decision.organizationName,
      organizationId: decision.organizationId,
      reason: decision.reason,
      evidence: decision.evidence,
    })
    .returning({ id: revealSkips.id });
  return row.id;
}

/** Record the employer of every teaser person a people search served (free data, upserted). */
export async function rememberTeaserEmployers(people: Array<{ id?: string | null; organization?: { name?: string | null } | null }>): Promise<void> {
  const byId = new Map<string, string>();
  for (const p of people) {
    const id = typeof p.id === "string" ? p.id : null;
    const name = typeof p.organization?.name === "string" ? p.organization.name.trim() : "";
    if (id && name) byId.set(id, name);
  }
  if (byId.size === 0) return;
  await db
    .insert(apolloTeaserPeople)
    .values([...byId].map(([apolloPersonId, organizationName]) => ({ apolloPersonId, organizationName })))
    .onConflictDoUpdate({
      target: apolloTeaserPeople.apolloPersonId,
      set: { organizationName: sql`excluded.organization_name`, lastSeenAt: sql`now()` },
    });
}
