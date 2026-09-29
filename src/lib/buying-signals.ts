/**
 * Buying signals: an audience criterion that says a company or a person just
 * did something that makes them ready to buy NOW. Three signals, all native to
 * Apollo People Search and measured honored live 2026-09-29 (free teaser
 * counts, baseline "CEO + United States" = 356,526 verified):
 *
 *   hiring      organization_job_posted_at_range (+ q_organization_job_titles)
 *               last 30 days → 54,892; + "head of sales" → 258
 *   job_change  person_days_in_current_title_range  ≤ 90 days → 2,025
 *   funding     latest_funding_date_range           since 07-01 → 1,806
 *
 * An impossible bound (a 2030 posting date, 100,000 days in title) returns 0,
 * so each field is honored rather than silently dropped. Max bounds are
 * honored too (a bounded funding window 1,806 → 1,258).
 *
 * Layering:
 *   bronze → `apollo_job_postings_fetches` (Apollo job-postings calls verbatim)
 *            + the existing `apollo_people_enrichments.response_raw`
 *   silver → `buying_signals` (one dated, sourced fact per type/source/ref)
 *   gold   → `apollo_signal_serves` (which cohort served a person to a
 *            campaign) and the `buyingSignal` field /enrich returns
 *
 * Rolling cohorts: an audience stores the RELATIVE spec ({type, window_days}).
 * /search/next materializes it into a cohort pinned to a day (`as_of`). When
 * a cohort is walked to its end, the next serve on a LATER day opens a new
 * cohort that only covers signals after the previous one (`since`), so a
 * stream of new signals keeps filling the same audience without re-walking the
 * whole window. Nothing here fabricates a signal or a date: evidence is only
 * what Apollo returned.
 */
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { apolloJobPostingsFetches, apolloSearchCursors, apolloSignalServes, buyingSignals } from "../db/schema.js";
import { getOrganizationJobPostings, type ApolloJobPosting } from "./apollo-client.js";
import { addDays, readSignalSpec, toDay, utcDay, type BuyingSignalSpec, type BuyingSignalType } from "./buying-signal-spec.js";
import { advisoryXactLock } from "./advisory-lock.js";
import { decryptKey } from "./keys-client.js";
import { assertKeySource } from "./validators.js";
import { addCosts, createRun, updateCostStatus, updateRun, type IdentityHeaders } from "./runs-client.js";
import { authorizeCredit } from "./billing-client.js";
import type { CreditAlertIdentity } from "./credit-alert.js";

export interface BuyingSignalEvidence {
  type: BuyingSignalType;
  occurredOn: string;
  fact: string;
  source: string;
  sourceUrl: string | null;
}

export const JOB_POSTINGS_COST_NAME = "apollo-credit";
export const JOB_POSTINGS_CACHE_DAYS = 7;
const JOB_CHANGE_MONTH_SLACK_DAYS = 31;

export class BuyingSignalInsufficientCreditError extends Error {
  constructor(public readonly balanceCents: number, public readonly requiredCents: number) {
    super("Insufficient credits to buy buying-signal evidence");
    this.name = "BuyingSignalInsufficientCreditError";
  }
}

// ─── Rolling cohorts (serve path) ────────────────────────────────────────────

function withoutCohortPin(params: Record<string, unknown>): Record<string, unknown> {
  const spec = readSignalSpec(params);
  if (!spec) return params;
  const { as_of: _asOf, since: _since, ...relative } = spec;
  return { ...params, buying_signal: relative };
}

/**
 * The cohort a first-page /search/next call for a signal audience walks, as the
 * exact params its cursor is keyed on:
 *  - no cohort yet for this campaign → the whole window, pinned to today;
 *  - the latest cohort is still open → keep walking it (any day);
 *  - the latest cohort is walked out on an earlier day → a new cohort pinned to
 *    today covering only signals since that cohort's day;
 *  - walked out today → that same cohort (it answers done until tomorrow).
 */
export async function resolveSignalCohort(
  orgId: string,
  campaignId: string,
  params: Record<string, unknown>,
  now: Date,
): Promise<Record<string, unknown>> {
  const relative = withoutCohortPin(params);
  const today = utcDay(now);
  const [latest] = await db
    .select({ searchParams: apolloSearchCursors.searchParams, exhausted: apolloSearchCursors.exhausted })
    .from(apolloSearchCursors)
    .where(
      and(
        eq(apolloSearchCursors.orgId, orgId),
        eq(apolloSearchCursors.campaignId, campaignId),
        sql`(${apolloSearchCursors.searchParams} #- '{buying_signal,as_of}' #- '{buying_signal,since}') = ${JSON.stringify(relative)}::jsonb`,
      ),
    )
    .orderBy(sql`${apolloSearchCursors.searchParams}->'buying_signal'->>'as_of' DESC NULLS LAST`, desc(apolloSearchCursors.updatedAt))
    .limit(1);

  const spec = readSignalSpec(relative)!;
  if (!latest) return { ...relative, buying_signal: { ...spec, as_of: today } };

  const latestParams = latest.searchParams as Record<string, unknown>;
  const latestAsOf = readSignalSpec(latestParams)?.as_of;
  if (!latest.exhausted || !latestAsOf || latestAsOf >= today) return latestParams;
  return { ...relative, buying_signal: { ...spec, as_of: today, since: latestAsOf } };
}

/** Remember which cohort served each teaser person to this campaign. */
export async function recordSignalServes(args: {
  orgId: string;
  brandIds: string[];
  campaignId: string;
  cursorId: string;
  spec: BuyingSignalSpec;
  apolloPersonIds: string[];
}): Promise<void> {
  const ids = [...new Set(args.apolloPersonIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (ids.length === 0) return;
  await db
    .insert(apolloSignalServes)
    .values(
      ids.map((apolloPersonId) => ({
        orgId: args.orgId,
        brandIds: args.brandIds,
        campaignId: args.campaignId,
        cursorId: args.cursorId,
        apolloPersonId,
        signal: args.spec,
      })),
    )
    .onConflictDoUpdate({
      target: [apolloSignalServes.orgId, apolloSignalServes.campaignId, apolloSignalServes.apolloPersonId],
      set: { cursorId: args.cursorId, signal: args.spec, servedAt: new Date() },
    });
}

// ─── Evidence (silver) ───────────────────────────────────────────────────────

export interface SilverSignal {
  signalType: BuyingSignalType;
  apolloOrganizationId: string | null;
  apolloPersonId: string | null;
  occurredOn: string;
  fact: string;
  source: string;
  sourceRef: string;
  sourceUrl: string | null;
  detail: Record<string, unknown> | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function monthYear(day: string): string {
  return `${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
}

function longDay(day: string): string {
  return `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}, ${day.slice(0, 4)}`;
}

/** The fields of an enriched person the free signals read (fresh or cached shape). */
export interface EnrichedPersonLike {
  id?: string | null;
  organizationId?: string | null;
  organizationName?: string | null;
  title?: string | null;
  employmentHistory?: unknown;
  organizationFundingEvents?: unknown;
  organizationLatestFundingRoundDate?: string | null;
  organizationLatestFundingStage?: string | null;
}

/**
 * Signals readable for free from an enrichment Apollo already returned: every
 * dated funding event of the employer, and the start of the person's current
 * title. An entry without a date yields nothing.
 */
export function deriveEnrichmentSignals(person: EnrichedPersonLike): SilverSignal[] {
  const out: SilverSignal[] = [];
  const orgId = str(person.organizationId);
  const orgName = str(person.organizationName);
  const personId = str(person.id);

  const events = Array.isArray(person.organizationFundingEvents) ? person.organizationFundingEvents : [];
  for (const e of events as Array<Record<string, unknown>>) {
    const day = toDay(e?.date);
    if (!day || !orgId) continue;
    const kind = str(e.type);
    const amount = str(e.amount);
    const currency = str(e.currency) ?? "";
    const investors = str(e.investors);
    const round = kind ? `a ${kind} round` : "a funding round";
    const fact =
      `${orgName ?? "The company"} raised ${round}${amount ? ` of ${currency}${amount}` : ""} on ${longDay(day)}` +
      (investors ? ` (investors: ${investors})` : "");
    out.push({
      signalType: "funding",
      apolloOrganizationId: orgId,
      apolloPersonId: null,
      occurredOn: day,
      fact,
      source: "apollo:enrichment",
      sourceRef: str(e.id) ?? `${orgId}:${day}:${kind ?? "round"}`,
      sourceUrl: str(e.news_url),
      detail: e,
    });
  }
  const latestDay = toDay(person.organizationLatestFundingRoundDate);
  if (orgId && latestDay && !out.some((s) => s.occurredOn === latestDay)) {
    const stage = str(person.organizationLatestFundingStage);
    out.push({
      signalType: "funding",
      apolloOrganizationId: orgId,
      apolloPersonId: null,
      occurredOn: latestDay,
      fact: `${orgName ?? "The company"} raised ${stage ? `a ${stage} round` : "a funding round"} on ${longDay(latestDay)}`,
      source: "apollo:enrichment",
      sourceRef: `${orgId}:latest:${latestDay}`,
      sourceUrl: null,
      detail: { latest_funding_round_date: person.organizationLatestFundingRoundDate, latest_funding_stage: stage },
    });
  }

  const history = Array.isArray(person.employmentHistory) ? person.employmentHistory : [];
  const current = (history as Array<Record<string, unknown>>).find((h) => h?.current === true);
  const started = toDay(current?.startDate ?? current?.start_date);
  if (current && started && personId) {
    const title = str(current.title) ?? str(person.title);
    const at = str(current.organizationName ?? current.organization_name) ?? orgName;
    out.push({
      signalType: "job_change",
      apolloOrganizationId: orgId,
      apolloPersonId: personId,
      occurredOn: started,
      fact: `Started as ${title ?? "their current role"}${at ? ` at ${at}` : ""} in ${monthYear(started)}`,
      source: "apollo:enrichment",
      sourceRef: `${personId}:${str(current.id) ?? started}`,
      sourceUrl: null,
      detail: current,
    });
  }
  return out;
}

/** One silver hiring signal per dated posting. */
export function hiringSignalsFromPostings(apolloOrganizationId: string, organizationName: string | null, postings: ApolloJobPosting[]): SilverSignal[] {
  const out: SilverSignal[] = [];
  for (const p of postings) {
    const day = toDay(p.posted_at);
    const title = str(p.title);
    const id = str(p.id);
    if (!day || !title || !id) continue;
    const place = [str(p.city), str(p.country)].filter(Boolean).join(", ");
    out.push({
      signalType: "hiring",
      apolloOrganizationId,
      apolloPersonId: null,
      occurredOn: day,
      fact: `${organizationName ?? "The company"} posted a job for ${title}${place ? ` (${place})` : ""} on ${longDay(day)}`,
      source: "apollo:job_postings",
      sourceRef: id,
      sourceUrl: str(p.url),
      detail: p as Record<string, unknown>,
    });
  }
  return out;
}

/**
 * The evidence for the signal a cohort matched: same type, dated inside the
 * cohort's window, most recent first; for hiring with job titles, a posting
 * naming one of them wins over any other posting. Null when Apollo's own data
 * holds nothing dated in the window: never invented.
 */
export function pickMatchedSignal(spec: BuyingSignalSpec, signals: SilverSignal[], now: Date): SilverSignal | null {
  const to = spec.as_of ?? utcDay(now);
  const from = addDays(to, -spec.window_days - (spec.type === "job_change" ? JOB_CHANGE_MONTH_SLACK_DAYS : 0));
  const inWindow = signals
    .filter((s) => s.signalType === spec.type && s.occurredOn >= from && s.occurredOn <= to)
    .sort((a, b) => (a.occurredOn < b.occurredOn ? 1 : a.occurredOn > b.occurredOn ? -1 : 0));
  if (spec.type === "hiring" && spec.job_titles?.length) {
    const wanted = spec.job_titles.map((t) => t.toLowerCase());
    const named = inWindow.find((s) => {
      const title = String((s.detail as { title?: unknown } | null)?.title ?? "").toLowerCase();
      return wanted.some((w) => title.includes(w));
    });
    if (named) return named;
  }
  return inWindow[0] ?? null;
}

export async function upsertSilverSignals(signals: SilverSignal[]): Promise<void> {
  if (signals.length === 0) return;
  await db
    .insert(buyingSignals)
    .values(signals)
    .onConflictDoUpdate({
      target: [buyingSignals.signalType, buyingSignals.source, buyingSignals.sourceRef],
      set: { lastSeenAt: new Date(), fact: sql`excluded.fact`, occurredOn: sql`excluded.occurred_on`, sourceUrl: sql`excluded.source_url`, detail: sql`excluded.detail` },
    });
}

function toEvidence(s: SilverSignal): BuyingSignalEvidence {
  return { type: s.signalType, occurredOn: s.occurredOn, fact: s.fact, source: s.source, sourceUrl: s.sourceUrl };
}

// ─── Hiring evidence (paid, cached per company) ─────────────────────────────

interface EvidenceContext {
  identity: IdentityHeaders;
  runId: string;
  alertIdentity?: CreditAlertIdentity;
}

/**
 * The company's job postings: the latest bronze fetch under
 * JOB_POSTINGS_CACHE_DAYS, else bought from Apollo under provision → authorize
 * → execute → actualize against the caller's org. A per-company advisory lock
 * keeps two concurrent reveals at the same company from paying twice.
 */
async function loadJobPostings(apolloOrganizationId: string, ctx: EvidenceContext): Promise<ApolloJobPosting[]> {
  return db.transaction(async (tx) => {
    await advisoryXactLock(tx, `apollo-job-postings:${apolloOrganizationId}`);
    const freshAfter = new Date(Date.now() - JOB_POSTINGS_CACHE_DAYS * 86_400_000);
    const [cached] = await tx
      .select()
      .from(apolloJobPostingsFetches)
      .where(and(eq(apolloJobPostingsFetches.apolloOrganizationId, apolloOrganizationId), gt(apolloJobPostingsFetches.fetchedAt, freshAfter)))
      .orderBy(desc(apolloJobPostingsFetches.fetchedAt))
      .limit(1);
    if (cached) return ((cached.responseBody as { organization_job_postings?: ApolloJobPosting[] }).organization_job_postings ?? []);

    const { identity } = ctx;
    const { key, keySource } = await decryptKey(identity.orgId, identity.userId!, "apollo", { callerMethod: "POST", callerPath: "/enrich" }, identity);
    assertKeySource(keySource);

    const run = await createRun({
      orgId: identity.orgId,
      userId: identity.userId,
      brandIds: identity.brandIds,
      campaignId: identity.campaignId,
      audienceId: identity.audienceId,
      featureSlug: identity.featureSlug,
      workflowSlug: identity.workflowSlug,
      serviceName: "apollo-service",
      taskName: "buying-signal-evidence",
      parentRunId: ctx.runId,
    });
    const provisioned = await addCosts(run.id, [{ costName: JOB_POSTINGS_COST_NAME, costSource: keySource, quantity: 1, status: "provisioned" }], identity);
    const holdId = provisioned.costs?.[0]?.id ?? null;
    const releaseHold = async (status: "completed" | "failed") => {
      if (holdId) await updateCostStatus(run.id, holdId, "cancelled", identity);
      await updateRun(run.id, status, identity);
    };

    if (keySource === "platform") {
      const auth = await authorizeCredit({
        items: [{ costName: JOB_POSTINGS_COST_NAME, quantity: 1 }],
        description: "apollo-buying-signal-evidence",
        orgId: identity.orgId,
        userId: identity.userId!,
        runId: ctx.runId,
        brandIds: identity.brandIds,
        campaignId: identity.campaignId,
        audienceId: identity.audienceId,
        featureSlug: identity.featureSlug,
        workflowSlug: identity.workflowSlug,
      });
      if (!auth.sufficient) {
        await releaseHold("failed");
        throw new BuyingSignalInsufficientCreditError(auth.balance_cents, auth.required_cents);
      }
    }

    let body;
    try {
      body = await getOrganizationJobPostings(key, apolloOrganizationId, ctx.alertIdentity);
    } catch (error) {
      await releaseHold("failed");
      throw error;
    }
    const postings = body.organization_job_postings ?? [];
    // Outside the lock tx on purpose: what Apollo billed is kept even if this request fails later.
    await db.insert(apolloJobPostingsFetches).values({ apolloOrganizationId, runId: run.id, postingsCount: postings.length, responseBody: body });
    // Apollo bills the call only when it returns postings (measured: 0 for an empty list).
    if (postings.length > 0) {
      await addCosts(run.id, [{ costName: JOB_POSTINGS_COST_NAME, costSource: keySource, quantity: 1 }], identity);
    }
    await releaseHold("completed");
    return postings;
  });
}

/**
 * The buying signal to hand the email writer for a revealed person, or null.
 * Only a person a signal cohort served to this org (campaign when known)
 * carries one; every evidence row is also stored in silver.
 */
export async function buyingSignalForEnrich(args: {
  apolloPersonId: string;
  person: EnrichedPersonLike;
  ctx: EvidenceContext;
  now?: Date;
}): Promise<BuyingSignalEvidence | null> {
  const { identity } = args.ctx;
  const now = args.now ?? new Date();
  const [serve] = await db
    .select()
    .from(apolloSignalServes)
    .where(
      and(
        eq(apolloSignalServes.orgId, identity.orgId),
        eq(apolloSignalServes.apolloPersonId, args.apolloPersonId),
        ...(identity.campaignId ? [eq(apolloSignalServes.campaignId, identity.campaignId)] : []),
      ),
    )
    .orderBy(desc(apolloSignalServes.servedAt))
    .limit(1);

  const free = deriveEnrichmentSignals({ ...args.person, id: args.person.id ?? args.apolloPersonId });
  await upsertSilverSignals(free);
  if (!serve) return null;

  const spec = serve.signal as BuyingSignalSpec;
  let candidates = free;
  if (spec.type === "hiring") {
    const orgId = str(args.person.organizationId);
    if (!orgId) return null;
    const postings = await loadJobPostings(orgId, args.ctx);
    const hiring = hiringSignalsFromPostings(orgId, str(args.person.organizationName), postings);
    await upsertSilverSignals(hiring);
    candidates = hiring;
  }
  const matched = pickMatchedSignal(spec, candidates, now);
  return matched ? toEvidence(matched) : null;
}
