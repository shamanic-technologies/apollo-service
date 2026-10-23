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
import { and, asc, eq, inArray, lt, lte } from "drizzle-orm";
import { db } from "../db/index.js";
import { outcomeDeclarations, type OutcomeDeclaration } from "../db/schema.js";
import { declareRunOutcomes, type OutcomeSubjectItem } from "./runs-client.js";
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

export async function resolveLeadIds(items: LeadResolveItem[]): Promise<(string | null)[]> {
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
  if (row.brandIds && row.brandIds.length > 0) item.brandIds = row.brandIds;
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
    .where(and(eq(outcomeDeclarations.status, "pending"), lte(outcomeDeclarations.nextAttemptAt, now)))
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

export function startOutcomeDeclarer(): NodeJS.Timeout {
  const tick = () => {
    declarePendingOutcomes().catch((err) => console.error("[Apollo Service] outcome_declarations.pass_failed", err));
  };
  setTimeout(tick, 60_000).unref();
  const timer = setInterval(tick, DECLARE_INTERVAL_MS);
  timer.unref();
  return timer;
}
