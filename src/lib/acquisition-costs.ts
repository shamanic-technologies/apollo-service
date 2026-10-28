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
  by: "pid" | "email";
  key: string;
  kind: AcquisitionKind;
  run_id: string;
  org_id: string;
}

type FoundAcquisition = Omit<AcquisitionRow, "idx">;

/**
 * BOX-LOAD-1028: lead-service re-asks the same orgs' whole served stock every few
 * minutes (features-service polls it), ~1,300 people per call, and this lookup was
 * the biggest apollo statement on the box (~1.6 s mean, 14k calls in 40 h). What an
 * EARLIER run paid for a person only grows by new acquisitions, which start after
 * the serves already asked about, so a person's paid rows are kept per lookup key
 * (apollo person id / normalized email) for ACQUISITION_ROWS_TTL_MS, empty answers
 * included, and only keys not seen recently go to Postgres. Same TTL as the run
 * prices (RUN_COST_TTL_MS): a new acquisition shows within 10 minutes.
 */
export const ACQUISITION_ROWS_TTL_MS = 10 * 60_000;
const ACQUISITION_ROWS_CACHE_MAX = 200_000;
const acquisitionRowsCache = new Map<string, { rows: FoundAcquisition[]; until: number }>();
const pidKey = (pid: string) => `pid:${pid}`;
const emailKey = (email: string) => `email:${email}`;

/** Test seam. */
export function __resetAcquisitionRowsCache(): void {
  acquisitionRowsCache.clear();
}

/** Every PAID acquisition of the asked people in our tables, any org. */
export async function findAcquisitionRows(people: ServedLead[]): Promise<AcquisitionRow[]> {
  const now = Date.now();
  const asked = people.map((p) => ({ pid: p.apolloPersonId ?? null, email: normEmail(p.email) }));
  const pids = new Set<string>();
  const emails = new Set<string>();
  for (const a of asked) {
    if (a.pid !== null && !((acquisitionRowsCache.get(pidKey(a.pid))?.until ?? 0) > now)) pids.add(a.pid);
    if (a.email !== null && !((acquisitionRowsCache.get(emailKey(a.email))?.until ?? 0) > now)) emails.add(a.email);
  }

  const fresh = new Map<string, FoundAcquisition[]>();
  if (pids.size > 0 || emails.size > 0) {
    // Each branch matches on exactly the predicate of its covering index
    // (migration 0047), so every lookup is an index-only scan.
    const rows = (await db.execute(sql`
      WITH pids AS (
        SELECT value AS pid FROM jsonb_array_elements_text(${JSON.stringify([...pids])}::jsonb)
      ), emails AS (
        SELECT value AS email FROM jsonb_array_elements_text(${JSON.stringify([...emails])}::jsonb)
      )
      SELECT 'pid' AS by, a.pid AS key, 'apollo_reveal' AS kind, e.enrichment_run_id AS run_id, e.org_id::text AS org_id
        FROM pids a JOIN apollo_people_enrichments e ON e.apollo_person_id = a.pid
        WHERE e.enrichment_run_id IS NOT NULL
      UNION
      SELECT 'email', a.email, 'apollo_reveal', e.enrichment_run_id, e.org_id::text
        FROM emails a JOIN apollo_people_enrichments e ON lower(btrim(e.email)) = a.email
        WHERE e.email IS NOT NULL AND e.enrichment_run_id IS NOT NULL
      UNION
      SELECT 'pid', a.pid, 'email_find', f.find_run_id, f.org_id::text
        FROM pids a JOIN email_findings f ON f.apollo_person_id = a.pid
        WHERE f.find_run_id IS NOT NULL
      UNION
      SELECT 'email', a.email, 'email_find', f.find_run_id, f.org_id::text
        FROM emails a JOIN email_findings f ON lower(btrim(f.email)) = a.email
        WHERE f.find_run_id IS NOT NULL
      UNION
      SELECT 'email', a.email, 'email_verification', v.verify_run_id, v.org_id::text
        FROM emails a JOIN email_verifications v ON v.email = a.email
        WHERE v.billed AND v.verify_run_id IS NOT NULL
    `)) as unknown as RawRow[];
    for (const pid of pids) fresh.set(pidKey(pid), []);
    for (const email of emails) fresh.set(emailKey(email), []);
    for (const r of rows) {
      const key = r.by === "pid" ? pidKey(r.key) : emailKey(r.key);
      fresh.get(key)?.push({ kind: r.kind, runId: r.run_id, orgId: r.org_id });
    }
    if (acquisitionRowsCache.size + fresh.size > ACQUISITION_ROWS_CACHE_MAX) acquisitionRowsCache.clear();
    const until = Date.now() + ACQUISITION_ROWS_TTL_MS;
    for (const [key, found] of fresh) acquisitionRowsCache.set(key, { rows: found, until });
  }

  const rowsOf = (key: string): FoundAcquisition[] => fresh.get(key) ?? acquisitionRowsCache.get(key)?.rows ?? [];
  const out: AcquisitionRow[] = [];
  asked.forEach((a, idx) => {
    const seen = new Set<string>();
    const found = [...(a.pid !== null ? rowsOf(pidKey(a.pid)) : []), ...(a.email !== null ? rowsOf(emailKey(a.email)) : [])];
    for (const f of found) {
      const k = `${f.kind}:${f.runId}:${f.orgId}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ idx, ...f });
    }
  });
  return out;
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
