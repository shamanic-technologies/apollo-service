/**
 * Outcome occurrences on OUR runs (COST-ACCOUNTING-1023, owner 2026-10-23).
 *
 * A run is a production order: runs-service gives each outcome occurrence a
 * run declares its exact cost. Every paid production point here names what it
 * produced (and, for a verification, what it consumed) for ONE person:
 *
 *   enrichment / email-find-* (found)          → produced email_found
 *   verify-email* (kept: valid/catch_all/unknown) → produced email_checked, consumed email_found
 *   phone-reveal (found)                        → produced phone_found
 *   buying-signal-evidence / linkedin-engagement → produced lead_identified
 *
 * The SUBJECT is the person's lead in lead-service (`subjectService:
 * "lead-service"`). That lead does not exist when we spend (a lead = a person
 * lead-service KEPT after our reveal/verification), so nothing is declared at
 * call time: `recordOutcome` parks a row in `outcome_declarations` (one local
 * insert, never throws, never slows the action) and the in-process declarer
 * asks lead-service `POST /internal/leads/ids/resolve` which lead it became,
 * then declares on our run. A person never kept within ABANDON_AFTER_MS was a
 * LOSS: nothing is declared and the run's cost rolls into the nearest
 * declaring ancestor (lead-service's serve), as the doctrine wants.
 *
 * Failures are loud and retried: a resolve or declaration that fails leaves
 * the row pending with `last_error`, the next pass retries it. runs-service is
 * idempotent per (run, direction, key, subject), so a replay records nothing
 * twice (`alreadyRecordedCount`).
 */
import { and, asc, eq, inArray, isNotNull, isNull, lt, lte } from "drizzle-orm";
import { db } from "../db/index.js";
import { outcomeDeclarations, type OutcomeDeclaration } from "../db/schema.js";
import { declareOutcomesBatch, declareRunOutcomes, RunsServiceError, type DeclareOutcomesBatchRun, type OutcomeSubjectItem } from "./runs-client.js";
import { errorMessage } from "./db-error.js";

export const SUBJECT_SERVICE = "lead-service";

export type OutcomeKey = "email_found" | "email_checked" | "phone_found" | "lead_identified";

/** How often the declarer runs. Short: lead-service consumes our outcomes the SAME UTC day it serves. */
export const DECLARE_INTERVAL_MS = 2 * 60 * 1000;
/** After this many quick attempts, a still-unresolved person is re-asked every SLOW_RETRY_MS. */
export const FAST_ATTEMPTS = 30;
export const SLOW_RETRY_MS = 30 * 60 * 1000;
/** Not a lead after this long = the spend was a loss: declare nothing. A row whose declaration keeps failing that long is abandoned too (its last_error says why). */
export const ABANDON_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
/** lead-service resolve and runs-service declaration both cap at 1000 items. */
export const BATCH = 500;

/** Verdicts whose verification is KEPT (the brief: valid, catch-all, unknown). An invalid one is a loss. */
const KEPT_VERDICTS = new Set(["valid", "catch_all", "unknown"]);

export function isKeptVerdict(verdict: string | null | undefined): boolean {
  return !!verdict && KEPT_VERDICTS.has(verdict);
}

export interface OutcomePerson {
  apolloPersonId?: string | null;
  email?: string | null;
  linkedinUrl?: string | null;
}

/** A subject the CALLER named (its own service and id): declared as is, never resolved through lead-service. */
export interface NamedSubject {
  subjectService: string;
  subjectId: string;
}

export interface RecordOutcomeInput {
  runId: string;
  /** Absent = the person's lead in lead-service, resolved later. */
  subject?: NamedSubject;
  orgId: string;
  brandIds?: string[] | null;
  campaignId?: string | null;
  produced?: OutcomeKey[];
  consumed?: OutcomeKey[];
  person: OutcomePerson;
}

/** One person, one key: apollo id first, then the lowercased email, then the LinkedIn URL. */
export function personKeyOf(person: OutcomePerson): string | null {
  if (person.apolloPersonId) return `apollo:${person.apolloPersonId}`;
  if (person.email) return `email:${person.email.trim().toLowerCase()}`;
  if (person.linkedinUrl) return `linkedin:${person.linkedinUrl.trim()}`;
  return null;
}

/**
 * Park what a run of ours produced/consumed for one person. Never throws: a
 * failed park is logged loud (the action it accompanies already happened and
 * must not fail for it), and the run's cost then rolls into its ancestor.
 */
export async function recordOutcome(input: RecordOutcomeInput): Promise<void> {
  const personKey = personKeyOf(input.person);
  if (!personKey) {
    console.error(`[Apollo Service] outcome_declarations.no_person run=${input.runId}: no apollo id, email or linkedin to name the subject`);
    return;
  }
  const rows = [
    ...(input.produced ?? []).map((outcomeKey) => ({ direction: "produced", outcomeKey })),
    ...(input.consumed ?? []).map((outcomeKey) => ({ direction: "consumed", outcomeKey })),
  ].map((r) => ({
    runId: input.runId,
    direction: r.direction,
    outcomeKey: r.outcomeKey,
    personKey,
    orgId: input.orgId,
    brandIds: input.brandIds && input.brandIds.length > 0 ? input.brandIds : null,
    campaignId: input.campaignId ?? null,
    apolloPersonId: input.person.apolloPersonId ?? null,
    email: input.person.email ? input.person.email.trim().toLowerCase() : null,
    linkedinUrl: input.person.linkedinUrl ?? null,
    subjectService: input.subject?.subjectService ?? null,
    leadId: input.subject?.subjectId ?? null,
  }));
  if (rows.length === 0) return;
  try {
    await db.insert(outcomeDeclarations).values(rows).onConflictDoNothing();
  } catch (err) {
    console.error(`[Apollo Service] outcome_declarations.park_failed run=${input.runId} keys=${rows.map((r) => `${r.direction}:${r.outcomeKey}`).join(",")}: ${errorMessage(err)}`);
  }
}

/** Fire-and-forget form for request paths: never awaited by the response. */
export function recordOutcomeDetached(input: RecordOutcomeInput): void {
  void recordOutcome(input);
}

// ─── lead-service: which lead did this person become? ────────────────────────

export interface LeadResolveItem {
  orgId: string;
  brandIds?: string[];
  apolloPersonId?: string;
  email?: string;
  linkedinUrl?: string;
}

export class LeadServiceUnconfiguredError extends Error {}

/**
 * People per resolve call. lead-service documents 1000 but its JSON body limit (100 kB) refuses
 * ~400 full items with a 413 that surfaces as a 500 (2026-10-23, first backfill pass of 500).
 */
export const RESOLVE_CHUNK = 200;

export async function resolveLeadIds(items: LeadResolveItem[]): Promise<(string | null)[]> {
  const out: (string | null)[] = [];
  for (let i = 0; i < items.length; i += RESOLVE_CHUNK) out.push(...(await resolveLeadIdsOnce(items.slice(i, i + RESOLVE_CHUNK))));
  return out;
}

async function resolveLeadIdsOnce(items: LeadResolveItem[]): Promise<(string | null)[]> {
  const url = process.env.LEAD_SERVICE_URL;
  const key = process.env.LEAD_SERVICE_API_KEY;
  if (!url || !key) throw new LeadServiceUnconfiguredError("LEAD_SERVICE_URL / LEAD_SERVICE_API_KEY not set");
  const res = await fetch(`${url}/internal/leads/ids/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key },
    body: JSON.stringify({ people: items }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`lead-service POST /internal/leads/ids/resolve failed: ${res.status} - ${(await res.text()).slice(0, 500)}`);
  const body = (await res.json()) as { people?: { leadId?: string | null }[] };
  if (!Array.isArray(body.people) || body.people.length !== items.length) {
    throw new Error(`lead-service resolve answered ${Array.isArray(body.people) ? body.people.length : "no"} people for ${items.length} asked`);
  }
  return body.people.map((p) => (typeof p.leadId === "string" && p.leadId ? p.leadId : null));
}

export function toResolveItem(row: Pick<OutcomeDeclaration, "orgId" | "brandIds" | "apolloPersonId" | "email" | "linkedinUrl">): LeadResolveItem {
  const item: LeadResolveItem = { orgId: row.orgId };
  // Old enrichment rows hold `{""}`: lead-service refuses an empty brand id (400 for the whole call).
  const brandIds = (row.brandIds ?? []).filter((b) => b.trim().length > 0);
  if (brandIds.length > 0) item.brandIds = brandIds;
  if (row.apolloPersonId) item.apolloPersonId = row.apolloPersonId;
  if (row.email) item.email = row.email;
  if (row.linkedinUrl) item.linkedinUrl = row.linkedinUrl;
  return item;
}

/** The runs-service body for one run's rows, all resolved. */
export function declarationBody(
  rows: Array<Pick<OutcomeDeclaration, "direction" | "outcomeKey" | "leadId"> & { subjectService?: string | null }>
): { produced: OutcomeSubjectItem[]; consumed: OutcomeSubjectItem[] } {
  const item = (r: (typeof rows)[number]): OutcomeSubjectItem => ({ outcomeKey: r.outcomeKey, subjectService: r.subjectService ?? SUBJECT_SERVICE, subjectId: r.leadId! });
  return {
    produced: rows.filter((r) => r.direction === "produced").map(item),
    consumed: rows.filter((r) => r.direction === "consumed").map(item),
  };
}

export function nextAttemptAt(attempts: number, now: Date): Date {
  return new Date(now.getTime() + (attempts < FAST_ATTEMPTS ? DECLARE_INTERVAL_MS : SLOW_RETRY_MS));
}

// ─── The declarer ────────────────────────────────────────────────────────────

export interface DeclarePassResult {
  due: number;
  abandoned: number;
  resolved: number;
  unresolved: number;
  declared: number;
  failedRuns: number;
}

let passRunning = false;

export async function declarePendingOutcomes(now: Date = new Date()): Promise<DeclarePassResult | null> {
  if (passRunning) return null;
  passRunning = true;
  try {
    return await declarePass(now);
  } finally {
    passRunning = false;
  }
}

async function declarePass(now: Date): Promise<DeclarePassResult> {
  const result: DeclarePassResult = { due: 0, abandoned: 0, resolved: 0, unresolved: 0, declared: 0, failedRuns: 0 };

  const abandonedRows = await db
    .update(outcomeDeclarations)
    .set({ status: "abandoned" })
    .where(and(eq(outcomeDeclarations.status, "pending"), lt(outcomeDeclarations.producedAt, new Date(now.getTime() - ABANDON_AFTER_MS))))
    .returning({ id: outcomeDeclarations.id });
  result.abandoned = abandonedRows.length;

  const due = await db
    .select()
    .from(outcomeDeclarations)
    .where(and(eq(outcomeDeclarations.status, "pending"), isNull(outcomeDeclarations.occurredAt), lte(outcomeDeclarations.nextAttemptAt, now)))
    .orderBy(asc(outcomeDeclarations.nextAttemptAt))
    .limit(BATCH);
  result.due = due.length;
  if (due.length === 0) return result;

  // 1. Resolve the lead of every row that has none yet.
  const toResolve = due.filter((r) => !r.leadId);
  if (toResolve.length > 0) {
    let leadIds: (string | null)[];
    try {
      leadIds = await resolveLeadIds(toResolve.map(toResolveItem));
    } catch (err) {
      const msg = errorMessage(err);
      console.error(`[Apollo Service] outcome_declarations.resolve_failed rows=${toResolve.length}: ${msg}`);
      await bumpAttempts(toResolve, now, `resolve: ${msg}`);
      // Rows already resolved on an earlier pass can still be declared.
      leadIds = [];
    }
    for (let i = 0; i < leadIds.length; i++) {
      const row = toResolve[i];
      const leadId = leadIds[i];
      if (leadId) {
        row.leadId = leadId;
        result.resolved++;
      }
    }
    const unresolved = leadIds.length > 0 ? toResolve.filter((r) => !r.leadId) : [];
    result.unresolved = unresolved.length;
    await bumpAttempts(unresolved, now, null);
    const newlyResolved = toResolve.filter((r) => r.leadId);
    for (const row of newlyResolved) {
      await db.update(outcomeDeclarations).set({ leadId: row.leadId }).where(eq(outcomeDeclarations.id, row.id));
    }
  }

  // 2. Declare every resolved row, one runs-service call per run.
  const byRun = new Map<string, OutcomeDeclaration[]>();
  for (const row of due) {
    if (!row.leadId) continue;
    const list = byRun.get(row.runId) ?? [];
    list.push(row);
    byRun.set(row.runId, list);
  }
  for (const [runId, rows] of byRun) {
    try {
      await declareRunOutcomes(runId, rows[0].orgId, declarationBody(rows));
      await db
        .update(outcomeDeclarations)
        .set({ status: "declared", declaredAt: now, lastError: null })
        .where(inArray(outcomeDeclarations.id, rows.map((r) => r.id)));
      result.declared += rows.length;
    } catch (err) {
      const msg = errorMessage(err);
      console.error(`[Apollo Service] outcome_declarations.declare_failed run=${runId} rows=${rows.length}: ${msg}`);
      await bumpAttempts(rows, now, `declare: ${msg}`);
      result.failedRuns++;
    }
  }

  if (result.declared > 0 || result.failedRuns > 0 || result.abandoned > 0) {
    console.log(`[Apollo Service] outcome_declarations.pass ${JSON.stringify(result)}`);
  }
  return result;
}

async function bumpAttempts(rows: OutcomeDeclaration[], now: Date, error: string | null): Promise<void> {
  for (const row of rows) {
    const attempts = row.attempts + 1;
    await db
      .update(outcomeDeclarations)
      .set({ attempts, nextAttemptAt: nextAttemptAt(attempts, now), ...(error ? { lastError: error.slice(0, 1000) } : {}) })
      .where(eq(outcomeDeclarations.id, row.id));
  }
}

// ─── The backfill declarer (COST-BACKFILL-1023) ──────────────────────────────
//
// Rows the backfill parked from PAST production (`occurred_at` set, see
// outcome-backfill.ts) go through runs-service's batch backfill door with
// `occurredAt: "run_started_at"`, so a past email_found counts as declared when
// its run happened and can feed a past verification or serve. Same resolve as the
// live rows; a person still not a lead when their row is older than
// ABANDON_AFTER_MS never will be (lead-service kept who it kept): abandoned at once.

/** runs-service batch door caps. */
export const BACKFILL_MAX_RUNS = 500;
export const BACKFILL_MAX_OCCURRENCES = 1000;
/** Passes per declarer tick: ~10k rows every 2 minutes, so the whole history drains in well under an hour. */
export const BACKFILL_PASSES_PER_TICK = 20;

export interface BackfillPassResult {
  due: number;
  resolved: number;
  noLead: number;
  declared: number;
  invalid: number;
  failed: number;
}

/** Group resolved rows per run and cut them into calls the batch door accepts (≤ 500 runs, ≤ 1000 occurrences). */
export function backfillChunks(rows: OutcomeDeclaration[]): Array<{ runs: DeclareOutcomesBatchRun[]; rows: OutcomeDeclaration[] }> {
  const byRun = new Map<string, OutcomeDeclaration[]>();
  for (const row of rows) {
    if (!row.leadId) continue;
    (byRun.get(row.runId) ?? byRun.set(row.runId, []).get(row.runId)!).push(row);
  }
  const chunks: Array<{ runs: DeclareOutcomesBatchRun[]; rows: OutcomeDeclaration[] }> = [];
  let current = { runs: [] as DeclareOutcomesBatchRun[], rows: [] as OutcomeDeclaration[] };
  for (const [runId, runRows] of byRun) {
    if (current.runs.length >= BACKFILL_MAX_RUNS || current.rows.length + runRows.length > BACKFILL_MAX_OCCURRENCES) {
      chunks.push(current);
      current = { runs: [], rows: [] };
    }
    const body = declarationBody(runRows);
    current.runs.push({ runId, occurredAt: "run_started_at", ...(body.produced.length ? { produced: body.produced } : {}), ...(body.consumed.length ? { consumed: body.consumed } : {}) });
    current.rows.push(...runRows);
  }
  if (current.runs.length > 0) chunks.push(current);
  return chunks;
}

/** The runs a batch refusal names (422 `invalid_runs`, 409 conflicts), with the reason each was refused. */
export function refusedRunsOf(err: unknown): Map<string, string> | null {
  if (!(err instanceof RunsServiceError) || (err.status !== 422 && err.status !== 409) || !err.body) return null;
  let body: { error?: string; details?: { invalid?: { runId?: string; reason?: string }[] }; conflicts?: { runId?: string }[] };
  try {
    body = JSON.parse(err.body);
  } catch {
    return null;
  }
  const refused = new Map<string, string>();
  for (const r of body.details?.invalid ?? []) if (r.runId) refused.set(r.runId, r.reason ?? "invalid");
  for (const c of body.conflicts ?? []) if (c.runId) refused.set(c.runId, body.error ?? "conflict");
  return refused.size > 0 ? refused : null;
}

export async function declareBackfillPass(now: Date = new Date()): Promise<BackfillPassResult> {
  const result: BackfillPassResult = { due: 0, resolved: 0, noLead: 0, declared: 0, invalid: 0, failed: 0 };
  const due = await db
    .select()
    .from(outcomeDeclarations)
    .where(and(eq(outcomeDeclarations.status, "pending"), isNotNull(outcomeDeclarations.occurredAt), lte(outcomeDeclarations.nextAttemptAt, now)))
    .orderBy(asc(outcomeDeclarations.nextAttemptAt))
    .limit(BATCH);
  result.due = due.length;
  if (due.length === 0) return result;

  const toResolve = due.filter((r) => !r.leadId);
  if (toResolve.length > 0) {
    let leadIds: (string | null)[];
    try {
      leadIds = await resolveLeadIds(toResolve.map(toResolveItem));
    } catch (err) {
      const msg = errorMessage(err);
      console.error(`[Apollo Service] outcome_backfill.resolve_failed rows=${toResolve.length}: ${msg}`);
      await bumpAttempts(toResolve, now, `resolve: ${msg}`);
      result.failed += toResolve.length;
      return result;
    }
    const stale = now.getTime() - ABANDON_AFTER_MS;
    const noLead: OutcomeDeclaration[] = [];
    const notYet: OutcomeDeclaration[] = [];
    for (let i = 0; i < toResolve.length; i++) {
      const row = toResolve[i];
      if (leadIds[i]) {
        row.leadId = leadIds[i];
        result.resolved++;
        await db.update(outcomeDeclarations).set({ leadId: row.leadId }).where(eq(outcomeDeclarations.id, row.id));
      } else if (row.occurredAt && row.occurredAt.getTime() < stale) {
        noLead.push(row);
      } else {
        notYet.push(row);
      }
    }
    if (noLead.length > 0) {
      await db
        .update(outcomeDeclarations)
        .set({ status: "abandoned", lastError: "backfill: no lead of the org holds this person" })
        .where(inArray(outcomeDeclarations.id, noLead.map((r) => r.id)));
    }
    result.noLead = noLead.length;
    await bumpAttempts(notYet, now, null);
  }

  for (const chunk of backfillChunks(due)) {
    await declareBackfillChunk(chunk.runs, chunk.rows, now, result);
  }
  return result;
}

/** A batch refusal that names no run: one run of the call is SUPPORT-marked (staff probe), which produces nothing. */
export function isSupportMarkedRefusal(err: unknown): boolean {
  return err instanceof RunsServiceError && err.status === 409 && !!err.body && err.body.includes("run_marked_support");
}

async function abandonRuns(refused: Map<string, string>): Promise<void> {
  for (const [runId, reason] of refused) {
    await db
      .update(outcomeDeclarations)
      .set({ status: "abandoned", lastError: `backfill: runs-service refused the run (${reason})` })
      .where(and(eq(outcomeDeclarations.runId, runId), isNotNull(outcomeDeclarations.occurredAt), eq(outcomeDeclarations.status, "pending")));
  }
}

/**
 * One batch call, all or nothing. A refused run (422 `invalid_runs`, 409 conflicts) is abandoned
 * with its reason and the rest re-sent. A 409 `run_marked_support` names no run, so the call is
 * split in halves until the marked run stands alone, then abandoned (a support run produces nothing).
 */
async function declareBackfillChunk(runs: DeclareOutcomesBatchRun[], rows: OutcomeDeclaration[], now: Date, result: BackfillPassResult): Promise<void> {
  for (let attempt = 0; runs.length > 0 && attempt < 3; attempt++) {
    try {
      await declareOutcomesBatch(runs);
      await db
        .update(outcomeDeclarations)
        .set({ status: "declared", declaredAt: now, lastError: null })
        .where(inArray(outcomeDeclarations.id, rows.map((r) => r.id)));
      result.declared += rows.length;
      return;
    } catch (err) {
      if (isSupportMarkedRefusal(err)) {
        if (runs.length === 1) {
          await abandonRuns(new Map([[runs[0].runId, "run_marked_support"]]));
          result.invalid += rows.length;
          return;
        }
        const half = Math.ceil(runs.length / 2);
        for (const part of [runs.slice(0, half), runs.slice(half)]) {
          const ids = new Set(part.map((r) => r.runId));
          await declareBackfillChunk(part, rows.filter((r) => ids.has(r.runId)), now, result);
        }
        return;
      }
      const refused = refusedRunsOf(err);
      if (!refused) {
        const msg = errorMessage(err);
        console.error(`[Apollo Service] outcome_backfill.declare_failed runs=${runs.length} rows=${rows.length}: ${msg}`);
        await bumpAttempts(rows, now, `backfill declare: ${msg}`);
        result.failed += rows.length;
        return;
      }
      await abandonRuns(refused);
      console.warn(`[Apollo Service] outcome_backfill.runs_refused ${JSON.stringify([...refused].slice(0, 20))}${refused.size > 20 ? ` (+${refused.size - 20})` : ""}`);
      result.invalid += rows.filter((r) => refused.has(r.runId)).length;
      runs = runs.filter((r) => !refused.has(r.runId));
      rows = rows.filter((r) => !refused.has(r.runId));
    }
  }
  if (runs.length > 0) {
    await bumpAttempts(rows, now, "backfill declare: runs-service kept refusing runs of this chunk");
    result.failed += rows.length;
  }
}

/** Drain the backfill queue a few passes at a time; shares the live declarer's single flight. */
export async function declareBackfillOutcomes(maxPasses = BACKFILL_PASSES_PER_TICK): Promise<BackfillPassResult | null> {
  if (passRunning) return null;
  passRunning = true;
  const total: BackfillPassResult = { due: 0, resolved: 0, noLead: 0, declared: 0, invalid: 0, failed: 0 };
  try {
    for (let i = 0; i < maxPasses; i++) {
      const pass = await declareBackfillPass();
      for (const k of Object.keys(total) as (keyof BackfillPassResult)[]) total[k] += pass[k];
      // Nothing moved forward (empty, or every row failed): wait for the next tick.
      if (pass.due === 0 || pass.declared + pass.noLead + pass.invalid === 0) break;
    }
  } finally {
    passRunning = false;
  }
  if (total.due > 0) console.log(`[Apollo Service] outcome_backfill.pass ${JSON.stringify(total)}`);
  return total;
}

export function startOutcomeDeclarer(): NodeJS.Timeout {
  const tick = () => {
    declarePendingOutcomes()
      .catch((err) => console.error("[Apollo Service] outcome_declarations.pass_failed", err))
      .then(() => declareBackfillOutcomes())
      .catch((err) => console.error("[Apollo Service] outcome_backfill.pass_failed", err));
  };
  setTimeout(tick, 60_000).unref();
  const timer = setInterval(tick, DECLARE_INTERVAL_MS);
  timer.unref();
  return timer;
}
