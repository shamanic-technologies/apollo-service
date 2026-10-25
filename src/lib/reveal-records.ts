import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

/**
 * "What did Apollo's paid reveal of person id P return?" — read from what we
 * already STORED (`apollo_people_enrichments`, one row per /enrich or /match
 * reveal). Free: no Apollo call, no cost, nothing written. Built for
 * human-service's "same human?" decision (LEDGER-RESIDUAL-1025-HUMANS): it
 * merges an id-only human with an email-only human only when the provider's
 * own record ties them, and refuses an address several Apollo people share or
 * an id whose reveals returned several addresses. So the answer carries BOTH
 * directions: per id every email, per email every Apollo person id.
 */
export const REVEAL_RECORDS_MAX_IDS = 1000;

export interface RevealedEmail {
  email: string;
  firstRevealedAt: string;
  lastRevealedAt: string;
  reveals: number;
}

export interface PersonRevealRecord {
  apolloPersonId: string;
  emails: RevealedEmail[];
  /** The one address when the id's reveals returned exactly one AND that address was returned for no other Apollo person id; else null. */
  unambiguousEmail: string | null;
}

export interface EmailRevealRecord {
  email: string;
  apolloPersonIds: string[];
}

export interface RevealRecordsAnswer {
  people: PersonRevealRecord[];
  emails: EmailRevealRecord[];
}

export interface RevealRow {
  apollo_person_id: string;
  email: string;
  first_at: Date | string;
  last_at: Date | string;
  reveals: number | string;
}

const iso = (v: Date | string) => (v instanceof Date ? v : new Date(v)).toISOString();

/** Pure: shape the (id, email) reveal pairs into the two-way answer, asked ids in request order. */
export function groupRevealRecords(askedIds: string[], rows: RevealRow[]): RevealRecordsAnswer {
  const byId = new Map<string, RevealedEmail[]>();
  const byEmail = new Map<string, Set<string>>();
  for (const r of rows) {
    const list = byId.get(r.apollo_person_id) ?? [];
    list.push({ email: r.email, firstRevealedAt: iso(r.first_at), lastRevealedAt: iso(r.last_at), reveals: Number(r.reveals) });
    byId.set(r.apollo_person_id, list);
    const ids = byEmail.get(r.email) ?? new Set<string>();
    ids.add(r.apollo_person_id);
    byEmail.set(r.email, ids);
  }
  const people = askedIds.map((id) => {
    const emails = (byId.get(id) ?? []).sort((a, b) => a.email.localeCompare(b.email));
    const only = emails.length === 1 ? emails[0].email : null;
    const unambiguousEmail = only && byEmail.get(only)?.size === 1 ? only : null;
    return { apolloPersonId: id, emails, unambiguousEmail };
  });
  const asked = new Set(askedIds);
  const reached = new Set<string>();
  for (const id of asked) for (const e of byId.get(id) ?? []) reached.add(e.email);
  const emails = [...reached].sort().map((email) => ({ email, apolloPersonIds: [...byEmail.get(email)!].sort() }));
  return { people, emails };
}

/** Trim, drop blanks, dedupe, keep first-seen order. */
export function normalizeAskedIds(ids: string[]): string[] {
  return [...new Set(ids.map((s) => s.trim()).filter(Boolean))];
}

export async function findRevealRecords(apolloPersonIds: string[]): Promise<RevealRecordsAnswer> {
  const asked = normalizeAskedIds(apolloPersonIds);
  if (asked.length === 0) return { people: [], emails: [] };
  // Step 1 (idx_enrichments_person_id): every address the asked ids' reveals returned.
  // Step 2 (idx_enrichments_email_norm, migration 0046): every reveal that returned
  // one of those addresses, whatever Apollo person id it was for.
  const rows = (await db.execute(sql`
    WITH asked AS (
      SELECT jsonb_array_elements_text(${JSON.stringify(asked)}::jsonb) AS pid
    ),
    reached AS (
      SELECT DISTINCT lower(btrim(e.email)) AS em
        FROM apollo_people_enrichments e JOIN asked a ON e.apollo_person_id = a.pid
       WHERE e.email IS NOT NULL AND btrim(e.email) <> ''
    )
    SELECT e.apollo_person_id, lower(btrim(e.email)) AS email,
           min(e.created_at) AS first_at, max(e.created_at) AS last_at, count(*) AS reveals
      FROM apollo_people_enrichments e
     WHERE e.email IS NOT NULL
       AND lower(btrim(e.email)) IN (SELECT em FROM reached)
       AND e.apollo_person_id IS NOT NULL AND btrim(e.apollo_person_id) <> ''
     GROUP BY e.apollo_person_id, lower(btrim(e.email))
  `)) as unknown as RevealRow[];
  return groupRevealRecords(asked, rows);
}
