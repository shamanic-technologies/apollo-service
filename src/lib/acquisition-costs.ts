import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { getRunCostsBatch, type BatchRunCost } from "./runs-client.js";

/**
 * "What did it cost to FIND the leads a campaign served, when an EARLIER run
 * paid for them?" (REUSED-ACQUISITION-COST-1017, first consumer features-service
 * via the leads lead-service served). A lead keeps the price paid to find it
 * (owner, 2026-10-17): a campaign that serves a person this service revealed,
 * found or verified for an earlier run serves it for free, so its own runs carry
 * no acquisition cost and its price per lead reads ~25x too cheap.
 *
 * Read-only. Nothing is billed, declared or moved: the earlier run already paid
 * and stays the payer. This only ATTRIBUTES that earlier spend to the serve.
 *
 * The caller says WHO was served (this service does not know: lead-service
 * serves from its own stock without calling us). We find every paid acquisition
 * of that person in our tables, price each from runs-service (the run's actual
 * cost, descendants included), and keep the EARLIER ones: paid by a run that
 * is not of the serving campaign and started before the serve.
 */

export const ACQUISITION_MAX_PEOPLE = 5000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AcquisitionKind = "apollo_reveal" | "email_find" | "email_verification";

export interface ServedLead {
  ref?: string;
  servedCampaignId: string;
  servedAt: string;
  apolloPersonId?: string;
  email?: string;
}

export interface Acquisition {
  kind: AcquisitionKind;
  runId: string;
  orgId: string;
  campaignId: string | null;
  workflowSlug: string | null;
  paidAt: string;
  costInUsdCents: string;
}

export interface ServedLeadAcquisitions {
  ref: string | null;
  servedCampaignId: string;
  servedAt: string;
  apolloPersonId: string | null;
  email: string | null;
  earlierAcquisitions: Acquisition[];
  earlierAcquisitionCostInUsdCents: string;
}

export interface CampaignAcquisitionTotals {
  campaignId: string;
  servedLeads: number;
  reusedLeads: number;
  earlierAcquisitionCostInUsdCents: string;
  paidByOtherOrgsCostInUsdCents: string;
}

export interface AcquisitionCostsResult {
  people: ServedLeadAcquisitions[];
  campaigns: CampaignAcquisitionTotals[];
  unpricedRunIds: string[];
}

/** A paid acquisition row found in our tables, before pricing. */
export interface AcquisitionRow {
  idx: number;
  kind: AcquisitionKind;
  runId: string;
  orgId: string;
}

// Cents carry up to 10 decimals (runs-service numeric(16,10)): summed as scaled
// integers so 382 additions do not drift.
const SCALE = 10;
function toScaled(cents: string): bigint {
  const neg = cents.startsWith("-");
  const [int, frac = ""] = (neg ? cents.slice(1) : cents).split(".");
  const v = BigInt(int || "0") * 10n ** BigInt(SCALE) + BigInt((frac + "0".repeat(SCALE)).slice(0, SCALE));
  return neg ? -v : v;
}
function fromScaled(v: bigint): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(SCALE);
  return `${neg ? "-" : ""}${abs / base}.${(abs % base).toString().padStart(SCALE, "0")}`;
}

function normEmail(email: string | undefined): string | null {
  const e = email?.trim().toLowerCase();
  return e ? e : null;
}

/**
 * Pure attribution: which of the found acquisitions are EARLIER for each serve,
 * and the per-campaign totals. An acquisition counts once per serve even when
 * it matched by both person id and email.
 */
export function attributeAcquisitions(
  servingOrgId: string,
  people: ServedLead[],
  rows: AcquisitionRow[],
  runs: Map<string, BatchRunCost>,
): AcquisitionCostsResult {
  const unpriced = new Set<string>();
  const perPerson: ServedLeadAcquisitions[] = people.map((p) => ({
    ref: p.ref ?? null,
    servedCampaignId: p.servedCampaignId,
    servedAt: new Date(p.servedAt).toISOString(),
    apolloPersonId: p.apolloPersonId ?? null,
    email: normEmail(p.email),
    earlierAcquisitions: [],
    earlierAcquisitionCostInUsdCents: fromScaled(0n),
  }));
  const seen = new Set<string>();
  const sums = new Map<number, bigint>();
  const otherOrgSums = new Map<number, bigint>();

  for (const row of rows) {
    const key = `${row.idx}:${row.kind}:${row.runId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const person = people[row.idx];
    if (!person) continue;
    const run = runs.get(row.runId);
    if (!run) {
      unpriced.add(row.runId);
      continue;
    }
    const isEarlier =
      run.campaignId !== person.servedCampaignId && new Date(run.startedAt).getTime() < new Date(person.servedAt).getTime();
    if (!isEarlier) continue;
    perPerson[row.idx].earlierAcquisitions.push({
      kind: row.kind,
      runId: run.id,
      orgId: row.orgId,
      campaignId: run.campaignId,
      workflowSlug: run.workflowSlug,
      paidAt: new Date(run.startedAt).toISOString(),
      costInUsdCents: run.actualCostInUsdCents,
    });
    const cost = toScaled(run.actualCostInUsdCents);
    sums.set(row.idx, (sums.get(row.idx) ?? 0n) + cost);
    if (row.orgId !== servingOrgId) {
      otherOrgSums.set(row.idx, (otherOrgSums.get(row.idx) ?? 0n) + cost);
    }
  }

  const campaigns = new Map<string, { served: number; reused: number; cost: bigint; otherOrg: bigint }>();
  perPerson.forEach((p, idx) => {
    p.earlierAcquisitions.sort((a, b) => a.paidAt.localeCompare(b.paidAt));
    const cost = sums.get(idx) ?? 0n;
    p.earlierAcquisitionCostInUsdCents = fromScaled(cost);
    const c = campaigns.get(p.servedCampaignId) ?? { served: 0, reused: 0, cost: 0n, otherOrg: 0n };
    c.served += 1;
    if (p.earlierAcquisitions.length > 0) c.reused += 1;
    c.cost += cost;
    c.otherOrg += otherOrgSums.get(idx) ?? 0n;
    campaigns.set(p.servedCampaignId, c);
  });

  return {
    people: perPerson,
    campaigns: [...campaigns.entries()].map(([campaignId, c]) => ({
      campaignId,
      servedLeads: c.served,
      reusedLeads: c.reused,
      earlierAcquisitionCostInUsdCents: fromScaled(c.cost),
      paidByOtherOrgsCostInUsdCents: fromScaled(c.otherOrg),
    })),
    unpricedRunIds: [...unpriced].sort(),
  };
}

interface RawRow {
  idx: number | string;
  kind: AcquisitionKind;
  run_id: string;
  org_id: string;
}

/** Every PAID acquisition of the asked people in our tables, any org. */
export async function findAcquisitionRows(people: ServedLead[]): Promise<AcquisitionRow[]> {
  const asked = people.map((p, idx) => ({ idx, pid: p.apolloPersonId ?? null, email: normEmail(p.email) }));
  const rows = (await db.execute(sql`
    WITH asked AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(asked)}::jsonb) AS a(idx int, pid text, email text)
    )
    SELECT a.idx, 'apollo_reveal' AS kind, e.enrichment_run_id AS run_id, e.org_id::text AS org_id
      FROM asked a JOIN apollo_people_enrichments e ON e.apollo_person_id = a.pid
      WHERE a.pid IS NOT NULL AND e.enrichment_run_id IS NOT NULL
    UNION
    SELECT a.idx, 'apollo_reveal', e.enrichment_run_id, e.org_id::text
      FROM asked a JOIN apollo_people_enrichments e ON lower(btrim(e.email)) = a.email
      WHERE a.email IS NOT NULL AND e.enrichment_run_id IS NOT NULL
    UNION
    SELECT a.idx, 'email_find', f.find_run_id, f.org_id::text
      FROM asked a JOIN email_findings f ON f.apollo_person_id = a.pid
      WHERE a.pid IS NOT NULL AND f.find_run_id IS NOT NULL
    UNION
    SELECT a.idx, 'email_find', f.find_run_id, f.org_id::text
      FROM asked a JOIN email_findings f ON lower(btrim(f.email)) = a.email
      WHERE a.email IS NOT NULL AND f.find_run_id IS NOT NULL
    UNION
    SELECT a.idx, 'email_verification', v.verify_run_id, v.org_id::text
      FROM asked a JOIN email_verifications v ON v.email = a.email
      WHERE a.email IS NOT NULL AND v.billed AND v.verify_run_id IS NOT NULL
  `)) as unknown as RawRow[];
  return rows.map((r) => ({ idx: Number(r.idx), kind: r.kind, runId: r.run_id, orgId: r.org_id }));
}

/**
 * Pricing a 5,000-lead read means ~5,400 runs over ~15 orgs. Asked one 500-id
 * chunk after the other it took ~30s and, under box load, a chunk passed the
 * runs-service timeout and the whole read 500'd (2026-10-17, orgs f0420eb5 and
 * 91e76989): lead-service then priced their campaigns nothing and the figure
 * flapped. Every (org, chunk) is now one job, RUNS_BATCH_CONCURRENCY at a time
 * (a call costs ~1.3s fixed + little per id, so wider chunks beat more calls),
 * and a run priced in the last RUN_COST_TTL_MS is not asked again (the runs
 * paying for an EARLIER acquisition are long settled). Fail loud stays: any
 * chunk failing after its retries fails the read.
 */
export const RUNS_BATCH_CHUNK = 500;
export const RUNS_BATCH_CONCURRENCY = 4;
export const RUN_COST_TTL_MS = 10 * 60_000;
const RUN_COST_CACHE_MAX = 100_000;

const runCostCache = new Map<string, { run: BatchRunCost; until: number }>();
const cacheKey = (orgId: string, runId: string) => `${orgId}:${runId}`;

/** Test seam. */
export function __resetRunCostCache(): void {
  runCostCache.clear();
}

/** Runs `jobs` with at most `limit` in flight; the first rejection rejects the whole. */
export async function mapWithConcurrency<T, R>(jobs: T[], limit: number, fn: (job: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(jobs.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < jobs.length) {
      const i = next++;
      try {
        out[i] = await fn(jobs[i]);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return out;
}

/** Prices every run: deduped per org, cached, chunked, a few runs-service batches at a time. */
export async function priceRuns(rows: AcquisitionRow[]): Promise<Map<string, BatchRunCost>> {
  const now = Date.now();
  const out = new Map<string, BatchRunCost>();
  const byOrg = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!UUID_RE.test(r.runId) || !UUID_RE.test(r.orgId)) continue;
    const hit = runCostCache.get(cacheKey(r.orgId, r.runId));
    if (hit && hit.until > now) {
      out.set(r.runId, hit.run);
      continue;
    }
    const set = byOrg.get(r.orgId) ?? new Set<string>();
    set.add(r.runId);
    byOrg.set(r.orgId, set);
  }
  const jobs: Array<{ orgId: string; ids: string[] }> = [];
  for (const [orgId, ids] of byOrg) {
    const list = [...ids];
    for (let i = 0; i < list.length; i += RUNS_BATCH_CHUNK) jobs.push({ orgId, ids: list.slice(i, i + RUNS_BATCH_CHUNK) });
  }
  const answers = await mapWithConcurrency(jobs, RUNS_BATCH_CONCURRENCY, async (job) => ({
    orgId: job.orgId,
    runs: await getRunCostsBatch(job.orgId, job.ids),
  }));
  const until = Date.now() + RUN_COST_TTL_MS;
  if (runCostCache.size > RUN_COST_CACHE_MAX) runCostCache.clear();
  for (const { orgId, runs } of answers) {
    for (const run of runs) {
      out.set(run.id, run);
      runCostCache.set(cacheKey(orgId, run.id), { run, until });
    }
  }
  return out;
}

export async function readAcquisitionCosts(orgId: string, people: ServedLead[]): Promise<AcquisitionCostsResult> {
  const rows = await findAcquisitionRows(people);
  const runs = await priceRuns(rows);
  return attributeAcquisitions(orgId, people, rows, runs);
}
