/**
 * COST-BACKFILL-1023 (owner 2026-10-23, « pour être à 100 % now »): the runs this
 * service opened BEFORE the live declarations (outcome-declarations.ts) paid for
 * outcomes too, and our own tables say which. This module re-reads them and parks
 * one `outcome_declarations` row per past outcome, with `occurred_at` = the source
 * row's instant. The declarer then resolves each person's lead and declares it on
 * the PAST run through runs-service's batch backfill door (`occurredAt:
 * "run_started_at"`), so it behaves as if declared when the run happened.
 *
 * The rules are the live production points', row for row (a test pins them):
 *   apollo_people_enrichments, verified email     → email_found      on enrichment_run_id
 *   email_findings found with an email            → email_found      on find_run_id
 *   email_verifications FINAL kept verdict        → email_checked + consumed email_found on verify_run_id
 *     (final = BounceBan's verdict, or a step-1 valid; before BounceBan existed
 *      (its first row), the step-1 verdict WAS the decision: catch_all/unknown kept too)
 *   apollo_phone_reveals found                    → phone_found      on reveal_run_id
 * Not parked, on purpose:
 *   - verifications asked for a transactional-email-service mailing list (the
 *     subject is a subscriber, not a lead; that service declares on its own run,
 *     ours rolls into it) and reveal-domain / staff probes (nobody's address);
 *   - buying-signal evidence and linkedin-engagement serves: their tables do not
 *     record WHICH person a past paid run was for, so nothing is declared by guess;
 *   - audience-companies (an onboarding preview) and the org-less platform lookups.
 *
 * Idempotent: the unique (run, direction, key, person) index skips every row
 * already parked, live or by an earlier backfill; runs-service skips every
 * occurrence already recorded. Re-running parks and declares nothing new.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

export type BackfillSource = "enrichment" | "email_finding" | "email_verification" | "phone_reveal";

const UUID_RE = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

/** Same order as personKeyOf: apollo id, then the lowercased email, then the LinkedIn URL. */
const personKey = (apollo: string, email: string, linkedin: string) =>
  `CASE WHEN ${apollo} IS NOT NULL THEN 'apollo:' || ${apollo}
        WHEN ${email} IS NOT NULL THEN 'email:' || lower(btrim(${email}))
        WHEN ${linkedin} IS NOT NULL THEN 'linkedin:' || btrim(${linkedin}) END`;

/**
 * Every past outcome our tables hold, one row per (run, direction, key, person),
 * in outcome_declarations' columns plus `source`.
 */
export const BACKFILL_CANDIDATES_SQL = `
  WITH bounceban_start AS (
    SELECT min(verified_at) AS at FROM email_verifications WHERE verifier = 'bounceban'
  ),
  candidates AS (
    SELECT 'enrichment' AS source, e.enrichment_run_id AS run_id, 'produced' AS direction, 'email_found' AS outcome_key,
           ${personKey("e.apollo_person_id", "e.email", "e.linkedin_url")} AS person_key,
           e.org_id, NULLIF(array_remove(e.brand_ids, ''), '{}') AS brand_ids, e.campaign_id, e.apollo_person_id,
           lower(btrim(e.email)) AS email, e.linkedin_url, e.created_at AS occurred_at
      FROM apollo_people_enrichments e
     WHERE e.email IS NOT NULL AND e.email_status = 'verified' AND e.enrichment_run_id ~* '${UUID_RE}'
    UNION ALL
    SELECT 'email_finding', f.find_run_id, 'produced', 'email_found',
           ${personKey("f.apollo_person_id", "f.email", "f.linkedin_url")},
           f.org_id, NULLIF(array_remove(f.brand_ids, ''), '{}'), f.campaign_id, f.apollo_person_id,
           lower(btrim(f.email)), f.linkedin_url, COALESCE(f.completed_at, f.created_at)
      FROM email_findings f
     WHERE f.status = 'found' AND f.email IS NOT NULL AND f.find_run_id ~* '${UUID_RE}'
    UNION ALL
    SELECT 'email_verification', v.verify_run_id, d.direction, d.outcome_key,
           'email:' || lower(btrim(v.email)),
           v.org_id, NULL::text[], NULL::text, NULL::text, lower(btrim(v.email)), NULL::text, v.verified_at
      FROM email_verifications v
      CROSS JOIN bounceban_start b
      CROSS JOIN (VALUES ('produced', 'email_checked'), ('consumed', 'email_found')) AS d(direction, outcome_key)
     WHERE v.verify_run_id ~* '${UUID_RE}'
       AND v.verdict IN ('valid', 'catch_all', 'unknown')
       AND (v.verifier = 'bounceban' OR v.verdict = 'valid' OR b.at IS NULL OR v.verified_at < b.at)
       AND COALESCE(v.source, '') NOT LIKE 'verify:transactional-email-service%'
       AND COALESCE(v.source, '') <> 'reveal-domain-probe'
       AND COALESCE(v.source, '') NOT LIKE 'verify:%probe%'
    UNION ALL
    SELECT 'phone_reveal', p.reveal_run_id, 'produced', 'phone_found',
           'apollo:' || p.apollo_person_id,
           p.org_id, NULLIF(array_remove(p.brand_ids, ''), '{}'), p.campaign_id, p.apollo_person_id, NULL::text, NULL::text,
           COALESCE(p.completed_at, p.created_at)
      FROM apollo_phone_reveals p
     WHERE p.status = 'found' AND p.reveal_run_id ~* '${UUID_RE}'
  )`;

export interface BackfillParkReport {
  dryRun: boolean;
  /** Past outcomes our tables hold, per source (one per direction: a verification is two). */
  candidates: Record<BackfillSource, number>;
  /** Rows newly parked by this call (0 on a dry run, 0 on a replay). */
  parked: number;
  /** The whole backfill queue after this call: rows parked from the past, by status. */
  queue: { pending: number; declared: number; abandoned: number };
}

export async function parkHistoricalOutcomes(opts: { dryRun: boolean }): Promise<BackfillParkReport> {
  const counts = (await db.execute(
    sql.raw(`${BACKFILL_CANDIDATES_SQL} SELECT source, count(*)::int AS n FROM candidates GROUP BY source`)
  )) as unknown as Array<{ source: BackfillSource; n: number }>;
  const candidates: Record<BackfillSource, number> = { enrichment: 0, email_finding: 0, email_verification: 0, phone_reveal: 0 };
  for (const r of counts) candidates[r.source] = Number(r.n);

  let parked = 0;
  if (!opts.dryRun) {
    const inserted = (await db.execute(
      sql.raw(`${BACKFILL_CANDIDATES_SQL}
        INSERT INTO outcome_declarations
          (run_id, direction, outcome_key, person_key, org_id, brand_ids, campaign_id, apollo_person_id, email, linkedin_url, occurred_at)
        SELECT run_id, direction, outcome_key, person_key, org_id, brand_ids, campaign_id, apollo_person_id, email, linkedin_url, occurred_at
          FROM candidates
         WHERE person_key IS NOT NULL
        ON CONFLICT (run_id, direction, outcome_key, person_key) DO NOTHING
        RETURNING 1`)
    )) as unknown as unknown[];
    parked = inserted.length;
  }

  const queueRows = (await db.execute(
    sql`SELECT status, count(*)::int AS n FROM outcome_declarations WHERE occurred_at IS NOT NULL GROUP BY status`
  )) as unknown as Array<{ status: string; n: number }>;
  const queue = { pending: 0, declared: 0, abandoned: 0 };
  for (const r of queueRows) if (r.status in queue) queue[r.status as keyof typeof queue] = Number(r.n);

  return { dryRun: opts.dryRun, candidates, parked, queue };
}
