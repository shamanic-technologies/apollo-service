import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { pgTextArray } from "./bulk-params.js";
import { DELIVERABLE_VERDICTS, SECOND_OPINION_VERDICTS, SECOND_OPINION_VERIFIER, type EmailVerdict } from "./email-verification.js";

/**
 * ENGINE-GET-ASK-1123: the Provider read of the verification Units this service
 * already holds (bronze `email_verifications`), for a Script that decides ITSELF
 * whether a held verdict is good enough before it pays for anything.
 *
 * Read-only: no vendor call, no run, no cost, nothing written. A verdict about an
 * address is a fleet-wide fact (the reveal paths' 30-day reuse already reuses any
 * org's verdict), so the read is NOT org-scoped; it never returns another org's
 * ids, raw vendor rows or costs.
 *
 * Served from `idx_email_verifications_email_at (email, verified_at)`; the ledger
 * subject comes from `idx_outcome_declarations_unique` (run_id leading).
 */
export const UNITS_MAX_EMAILS = 50;
export const UNITS_DEFAULT_LIMIT = 100;
export const UNITS_MAX_LIMIT = 500;

export interface UnitsQuery {
  emails: string[];
  since?: Date;
  decisive?: boolean;
  verdicts?: EmailVerdict[];
  includeFailed: boolean;
  limit: number;
  before?: string;
}

export interface UnitSubject {
  subjectService: string;
  subjectId: string;
  declared: boolean;
}

export interface EmailFoundUnit {
  verificationId: string;
  email: string;
  verdict: EmailVerdict | null;
  decisive: boolean;
  deliverable: boolean;
  step: "first" | "second";
  verifier: string;
  verifiedAt: string;
  ageDays: number;
  source: string | null;
  subject: UnitSubject | null;
}

export interface UnitsPage {
  units: EmailFoundUnit[];
  nextBefore: string | null;
  hasMore: boolean;
}

export interface RawUnitRow {
  seq: string | number;
  id: string;
  email: string;
  verifier: string;
  verdict: string | null;
  source: string | null;
  verified_at: Date | string;
  subject_service: string | null;
  lead_id: string | null;
  od_status: string | null;
}

/** Same rule as needsSecondOpinion: a step-1 catch_all/unknown is undecided (BounceBan decides it). */
export function isDecisive(verifier: string, verdict: string | null): boolean {
  if (verdict === null) return false;
  return verifier === SECOND_OPINION_VERIFIER || !SECOND_OPINION_VERDICTS.has(verdict as EmailVerdict);
}

export function toUnit(row: RawUnitRow, now: Date): EmailFoundUnit {
  const verifiedAt = new Date(row.verified_at);
  const verdict = row.verdict as EmailVerdict | null;
  const decisive = isDecisive(row.verifier, verdict);
  return {
    verificationId: row.id,
    email: row.email,
    verdict,
    decisive,
    deliverable: decisive && verdict !== null && DELIVERABLE_VERDICTS.has(verdict),
    step: row.verifier === SECOND_OPINION_VERIFIER ? "second" : "first",
    verifier: row.verifier,
    verifiedAt: verifiedAt.toISOString(),
    ageDays: Math.round(((now.getTime() - verifiedAt.getTime()) / 86_400_000) * 10) / 10,
    source: row.source,
    subject: row.lead_id ? { subjectService: row.subject_service ?? "lead-service", subjectId: row.lead_id, declared: row.od_status === "declared" } : null,
  };
}

export function unitsSql(q: UnitsQuery): SQL {
  const where: SQL[] = [sql`ev.email = ANY(${pgTextArray(q.emails)}::text[])`];
  if (q.since) where.push(sql`ev.verified_at >= ${q.since.toISOString()}`);
  if (!q.includeFailed) where.push(sql`ev.verdict IS NOT NULL`);
  if (q.verdicts && q.verdicts.length > 0) where.push(sql`ev.verdict = ANY(${pgTextArray(q.verdicts)}::text[])`);
  if (q.decisive === true) {
    where.push(sql`ev.verdict IS NOT NULL AND (ev.verifier = ${SECOND_OPINION_VERIFIER} OR ev.verdict NOT IN ('catch_all', 'unknown'))`);
  } else if (q.decisive === false) {
    where.push(sql`ev.verdict IN ('catch_all', 'unknown') AND ev.verifier <> ${SECOND_OPINION_VERIFIER}`);
  }
  if (q.before) where.push(sql`ev.seq < ${q.before}::bigint`);
  return sql`
    SELECT ev.seq, ev.id, ev.email, ev.verifier, ev.verdict, ev.source, ev.verified_at,
           od.subject_service, od.lead_id, od.status AS od_status
    FROM email_verifications ev
    LEFT JOIN LATERAL (
      SELECT d.subject_service, d.lead_id, d.status
      FROM outcome_declarations d
      WHERE ev.verify_run_id IS NOT NULL AND d.run_id = ev.verify_run_id
        AND d.direction = 'produced' AND d.outcome_key = 'email_checked'
      LIMIT 1
    ) od ON true
    WHERE ${sql.join(where, sql` AND `)}
    ORDER BY ev.seq DESC
    LIMIT ${q.limit + 1}`;
}

export async function readEmailFoundUnits(q: UnitsQuery, now: Date = new Date()): Promise<UnitsPage> {
  const rows = (await db.execute(unitsSql(q))) as unknown as RawUnitRow[];
  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  return {
    units: page.map((r) => toUnit(r, now)),
    nextBefore: hasMore ? String(page[page.length - 1].seq) : null,
    hasMore,
  };
}
