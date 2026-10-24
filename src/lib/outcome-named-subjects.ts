/**
 * LEDGER-HISTORY-1024: past checks a CALLER asked for on its own subjects.
 *
 * Since 2026-10-23 a caller of POST /email-verifications names the subject of each
 * address (`subjects`, e.g. transactional-email-service's mailing-list subscriber), and
 * the check declares `email_checked` on THAT subject. The checks it asked for before
 * (52k mailing-list rows since 2026-09-28) were parked nowhere: our rows hold the
 * address, never whose it was. Only the caller knows that, so it names them here and we
 * park, for each, every billed FINAL kept check of that address the caller itself asked
 * for (`source = verify:<callerLabel>`), on the run that paid, dated at the check. Same
 * rule as the live path: the check produced `email_checked`, nothing consumed (we never
 * found that address). Idempotent: the unique (run, direction, key, person) index skips
 * a check already parked, live or here.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

export interface NamedSubjectItem {
  email: string;
  subjectService: string;
  subjectId: string;
}

export interface NamedSubjectsReport {
  dryRun: boolean;
  subjects: number;
  /** Final kept checks of those addresses, asked by that caller: one email_checked each. */
  checks: number;
  /** Subjects with no such check in our rows (checked by nobody here, or only invalid / undecided). */
  subjectsWithoutCheck: number;
  parked: number;
}

const UUID_RE = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

/** One subject per address, as the live route requires. */
export function dedupeSubjects(items: NamedSubjectItem[]): { subjects: NamedSubjectItem[]; conflict: string | null } {
  const byEmail = new Map<string, NamedSubjectItem>();
  for (const s of items) {
    const email = s.email.trim().toLowerCase();
    const prior = byEmail.get(email);
    if (prior && (prior.subjectService !== s.subjectService || prior.subjectId !== s.subjectId)) return { subjects: [], conflict: email };
    byEmail.set(email, { email, subjectService: s.subjectService, subjectId: s.subjectId });
  }
  return { subjects: [...byEmail.values()], conflict: null };
}

export async function parkNamedSubjectChecks(opts: { callerLabel: string; subjects: NamedSubjectItem[]; dryRun: boolean }): Promise<NamedSubjectsReport> {
  const subjectsJson = JSON.stringify(opts.subjects.map((s) => ({ email: s.email, subject_service: s.subjectService, subject_id: s.subjectId })));
  const source = `verify:${opts.callerLabel}`;
  const candidates = sql`
    WITH bounceban_start AS (SELECT min(verified_at) AS at FROM email_verifications WHERE verifier = 'bounceban'),
    s AS (SELECT * FROM jsonb_to_recordset(${subjectsJson}::jsonb) AS x(email text, subject_service text, subject_id text)),
    c AS (
      SELECT v.verify_run_id AS run_id, v.org_id, s.email, s.subject_service, s.subject_id, v.verified_at
        FROM s
        JOIN email_verifications v ON lower(btrim(v.email)) = s.email
        CROSS JOIN bounceban_start b
       WHERE v.source = ${source}
         AND v.verify_run_id ~* ${UUID_RE}
         AND v.verdict IN ('valid', 'catch_all', 'unknown')
         AND (v.verifier = 'bounceban' OR v.verdict = 'valid' OR b.at IS NULL OR v.verified_at < b.at)
    )`;
  const [counts] = (await db.execute(sql`${candidates}
    SELECT (SELECT count(*) FROM c)::int AS checks,
           (SELECT count(*) FROM s WHERE NOT EXISTS (SELECT 1 FROM c WHERE c.email = s.email))::int AS without`)) as unknown as Array<{ checks: number; without: number }>;

  let parked = 0;
  if (!opts.dryRun) {
    const inserted = (await db.execute(sql`${candidates}
      INSERT INTO outcome_declarations
        (run_id, direction, outcome_key, person_key, org_id, email, subject_service, lead_id, occurred_at)
      SELECT run_id, 'produced', 'email_checked', 'email:' || email, org_id, email, subject_service, subject_id, verified_at FROM c
      ON CONFLICT (run_id, direction, outcome_key, person_key) DO NOTHING
      RETURNING 1`)) as unknown as unknown[];
    parked = inserted.length;
  }
  return { dryRun: opts.dryRun, subjects: opts.subjects.length, checks: Number(counts.checks), subjectsWithoutCheck: Number(counts.without), parked };
}
