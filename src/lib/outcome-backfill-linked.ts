/**
 * LEDGER-HISTORY-1024 (owner 2026-10-24): the two paid tasks the first backfill
 * (outcome-backfill.ts) could not reach, because their OWN rows do not carry the
 * run that paid. Both produce `lead_identified` live (outcome-declarations.ts);
 * the runs-service run tree (our own runs, read back through GET /v1/runs) gives
 * the missing link, and only an EXACT, single match is parked. Nothing is
 * declared by guess: an ambiguous row is counted and left out.
 *
 *   linkedin-engagement: a served row (`linkedin_engagement_serves`, status served)
 *     is stamped `served_at` INSIDE the serve run, between its start and its end.
 *     Its run = the one engagement run of the same org + campaign whose
 *     [startedAt, completedAt] holds `served_at`. Two windows hold it (two serves
 *     of one campaign at once) = ambiguous, skipped. Person = the served profile's
 *     LinkedIn URL in the form the live serve parks it.
 *   buying-signal-evidence: the run bought ONE company's job postings
 *     (`apollo_job_postings_fetches.run_id`) inside `/enrich` for ONE person, as a
 *     child of the caller's run, the same run the enrichment row records
 *     (`apollo_people_enrichments.run_id`). Person = the one enriched person of that
 *     org, under that caller run, employed by that company. Live parks only a run
 *     that was charged, so only runs with an own cost are parked here too.
 *
 * Idempotent like the rest of the backfill: the unique (run, direction, key,
 * person) index skips what is parked, runs-service records nothing twice.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { listRuns, type RunWithOwnCost } from "./runs-client.js";
import { canonicalLinkedinUrl } from "./quickenrich.js";

export const SERVICE_NAME = "apollo-service";
const PAGE = 500;

export interface LinkedRunWindow {
  id: string;
  campaignId: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface ServedEngager {
  orgId: string;
  brandIds: string[] | null;
  campaignId: string;
  servedAt: Date;
  linkedinUrl: string | null;
}

export interface LinkedPark {
  runId: string;
  orgId: string;
  brandIds: string[] | null;
  campaignId: string | null;
  apolloPersonId: string | null;
  email: string | null;
  linkedinUrl: string | null;
  occurredAt: Date;
}

export interface LinkedMatchReport {
  parks: LinkedPark[];
  /** Rows our tables hold for the task. */
  rows: number;
  /** Rows no run (or no person) matches: nothing paid for them on record. */
  unmatched: number;
  /** Rows two runs (or two people) match: never picked. */
  ambiguous: number;
}

/** Pure: each served engager → the ONE run of its org + campaign whose window holds its serve. */
export function matchServesToRuns(serves: ServedEngager[], runs: LinkedRunWindow[]): LinkedMatchReport {
  const byCampaign = new Map<string, LinkedRunWindow[]>();
  for (const r of runs) {
    if (!r.campaignId || !r.completedAt) continue;
    (byCampaign.get(r.campaignId) ?? byCampaign.set(r.campaignId, []).get(r.campaignId)!).push(r);
  }
  const out: LinkedMatchReport = { parks: [], rows: serves.length, unmatched: 0, ambiguous: 0 };
  for (const s of serves) {
    const t = s.servedAt.getTime();
    const hits = (byCampaign.get(s.campaignId) ?? []).filter((r) => Date.parse(r.startedAt) <= t && t <= Date.parse(r.completedAt!));
    if (hits.length > 1) {
      out.ambiguous++;
      continue;
    }
    if (hits.length === 0 || !s.linkedinUrl) {
      out.unmatched++;
      continue;
    }
    out.parks.push({
      runId: hits[0].id,
      orgId: s.orgId,
      brandIds: s.brandIds && s.brandIds.length > 0 ? s.brandIds : null,
      campaignId: s.campaignId,
      apolloPersonId: null,
      email: null,
      linkedinUrl: canonicalLinkedinUrl(s.linkedinUrl),
      occurredAt: s.servedAt,
    });
  }
  return out;
}

export interface EvidenceRun {
  id: string;
  parentRunId: string | null;
  campaignId: string | null;
  charged: boolean;
}

export interface EvidenceFetch {
  runId: string;
  apolloOrganizationId: string;
  fetchedAt: Date;
}

export interface EnrichedAtCompany {
  callerRunId: string;
  apolloOrganizationId: string;
  apolloPersonId: string;
  email: string | null;
  linkedinUrl: string | null;
  brandIds: string[] | null;
}

/** Pure: each charged evidence run → the ONE person enriched under the same caller run at the company it bought postings of. */
export function matchEvidenceToPersons(orgId: string, runs: EvidenceRun[], fetches: EvidenceFetch[], enriched: EnrichedAtCompany[]): LinkedMatchReport {
  const fetchOf = new Map(fetches.map((f) => [f.runId, f]));
  const out: LinkedMatchReport = { parks: [], rows: 0, unmatched: 0, ambiguous: 0 };
  for (const r of runs) {
    if (!r.charged) continue;
    out.rows++;
    const f = fetchOf.get(r.id);
    if (!f || !r.parentRunId) {
      out.unmatched++;
      continue;
    }
    const people = new Map<string, EnrichedAtCompany>();
    for (const e of enriched) if (e.callerRunId === r.parentRunId && e.apolloOrganizationId === f.apolloOrganizationId) people.set(e.apolloPersonId, e);
    if (people.size > 1) {
      out.ambiguous++;
      continue;
    }
    const person = [...people.values()][0];
    if (!person) {
      out.unmatched++;
      continue;
    }
    out.parks.push({
      runId: r.id,
      orgId,
      brandIds: person.brandIds && person.brandIds.length > 0 ? person.brandIds : null,
      campaignId: r.campaignId,
      apolloPersonId: person.apolloPersonId,
      email: person.email ? person.email.trim().toLowerCase() : null,
      linkedinUrl: person.linkedinUrl,
      occurredAt: f.fetchedAt,
    });
  }
  return out;
}

/** Every run of one task of ours in one org (GET /v1/runs, paged). */
async function ourRuns(orgId: string, taskName: string): Promise<RunWithOwnCost[]> {
  const all: RunWithOwnCost[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { runs } = await listRuns({ orgId, serviceName: SERVICE_NAME, taskName, limit: PAGE, offset });
    all.push(...runs);
    if (runs.length < PAGE) return all;
  }
}

const personKey = (p: LinkedPark) =>
  p.apolloPersonId ? `apollo:${p.apolloPersonId}` : p.email ? `email:${p.email}` : p.linkedinUrl ? `linkedin:${p.linkedinUrl.trim()}` : null;

async function park(parks: LinkedPark[]): Promise<number> {
  let parked = 0;
  for (let i = 0; i < parks.length; i += 500) {
    const chunk = parks.slice(i, i + 500).filter((p) => personKey(p));
    if (chunk.length === 0) continue;
    const values = sql.join(
      chunk.map(
        (p) =>
          sql`(${p.runId}, 'produced', 'lead_identified', ${personKey(p)}, ${p.orgId}::uuid, ${p.brandIds ? `{${p.brandIds.map((b) => `"${b}"`).join(",")}}` : null}::text[], ${p.campaignId}, ${p.apolloPersonId}, ${p.email}, ${p.linkedinUrl}, ${p.occurredAt.toISOString()}::timestamptz)`
      ),
      sql`, `
    );
    const inserted = (await db.execute(sql`
      INSERT INTO outcome_declarations
        (run_id, direction, outcome_key, person_key, org_id, brand_ids, campaign_id, apollo_person_id, email, linkedin_url, occurred_at)
      VALUES ${values}
      ON CONFLICT (run_id, direction, outcome_key, person_key) DO NOTHING
      RETURNING 1`)) as unknown as unknown[];
    parked += inserted.length;
  }
  return parked;
}

export interface LinkedBackfillReport {
  linkedin_engagement: Omit<LinkedMatchReport, "parks"> & { candidates: number };
  buying_signal_evidence: Omit<LinkedMatchReport, "parks"> & { candidates: number };
  parked: number;
}

export async function parkLinkedHistory(opts: { dryRun: boolean }): Promise<LinkedBackfillReport> {
  const report: LinkedBackfillReport = {
    linkedin_engagement: { candidates: 0, rows: 0, unmatched: 0, ambiguous: 0 },
    buying_signal_evidence: { candidates: 0, rows: 0, unmatched: 0, ambiguous: 0 },
    parked: 0,
  };
  const all: LinkedPark[] = [];
  const add = (key: keyof Omit<LinkedBackfillReport, "parked">, m: LinkedMatchReport) => {
    report[key].rows += m.rows;
    report[key].unmatched += m.unmatched;
    report[key].ambiguous += m.ambiguous;
    report[key].candidates += m.parks.length;
    all.push(...m.parks);
  };

  // linkedin-engagement
  const serves = (await db.execute(sql`
    SELECT s.org_id::text AS org_id, s.brand_ids, s.campaign_id, s.served_at, p.linkedin_url
      FROM linkedin_engagement_serves s
      LEFT JOIN linkedin_profiles p ON p.profile_id = s.profile_id
     WHERE s.status = 'served'`)) as unknown as Array<{ org_id: string; brand_ids: string[] | null; campaign_id: string; served_at: Date | string; linkedin_url: string | null }>;
  const servesByOrg = new Map<string, ServedEngager[]>();
  for (const s of serves) {
    (servesByOrg.get(s.org_id) ?? servesByOrg.set(s.org_id, []).get(s.org_id)!).push({
      orgId: s.org_id, brandIds: s.brand_ids, campaignId: s.campaign_id, servedAt: new Date(s.served_at), linkedinUrl: s.linkedin_url,
    });
  }
  for (const [orgId, list] of servesByOrg) {
    const runs = await ourRuns(orgId, "linkedin-engagement");
    add("linkedin_engagement", matchServesToRuns(list, runs));
  }

  // buying-signal-evidence
  const orgs = (await db.execute(sql`SELECT DISTINCT org_id::text AS org_id FROM apollo_signal_serves`)) as unknown as Array<{ org_id: string }>;
  for (const { org_id: orgId } of orgs) {
    const runs = (await ourRuns(orgId, "buying-signal-evidence")).map((r) => ({
      id: r.id, parentRunId: r.parentRunId, campaignId: r.campaignId, charged: Number(r.ownCostInUsdCents ?? 0) > 0,
    }));
    const charged = runs.filter((r) => r.charged);
    if (charged.length === 0) continue;
    const ids = charged.map((r) => r.id);
    const parents = [...new Set(charged.map((r) => r.parentRunId).filter((v): v is string => !!v))];
    const fetches = (await db.execute(sql`
      SELECT run_id, apollo_organization_id, fetched_at FROM apollo_job_postings_fetches
       WHERE run_id IN (SELECT unnest(${`{${ids.join(",")}}`}::text[]))`)) as unknown as Array<{ run_id: string; apollo_organization_id: string; fetched_at: Date | string }>;
    const enriched =
      parents.length === 0
        ? []
        : ((await db.execute(sql`
      SELECT run_id, organization_id, apollo_person_id, email, linkedin_url, brand_ids FROM apollo_people_enrichments
       WHERE org_id = ${orgId}::uuid AND organization_id IS NOT NULL AND apollo_person_id IS NOT NULL
         AND run_id IN (SELECT unnest(${`{${parents.join(",")}}`}::text[]))`)) as unknown as Array<{ run_id: string; organization_id: string; apollo_person_id: string; email: string | null; linkedin_url: string | null; brand_ids: string[] | null }>);
    add(
      "buying_signal_evidence",
      matchEvidenceToPersons(
        orgId,
        runs,
        fetches.map((f) => ({ runId: f.run_id, apolloOrganizationId: f.apollo_organization_id, fetchedAt: new Date(f.fetched_at) })),
        enriched.map((e) => ({ callerRunId: e.run_id, apolloOrganizationId: e.organization_id, apolloPersonId: e.apollo_person_id, email: e.email, linkedinUrl: e.linkedin_url, brandIds: e.brand_ids })),
      ),
    );
  }

  if (!opts.dryRun) report.parked = await park(all);
  return report;
}
