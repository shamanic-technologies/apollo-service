import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { normalizeAskedIds } from "./reveal-records.js";

/**
 * "What do we already know about Apollo person P?" — read from our STORED paid
 * reveals (`apollo_people_enrichments`, one row per /enrich or /match). Free:
 * no Apollo call, no cost, nothing written, org-less. Built for human-service's
 * candidate judge (BLANK-CANDIDATES-1101): people served before it stored the
 * teaser snapshot (2026-09-17) are re-offered blank, while we paid to reveal
 * them and hold Apollo's full person payload. Facts only: never an email or a
 * phone. The LATEST reveal carrying a title or an employer answers (a person
 * revealed twice can have changed job); an id never revealed = `known: false`.
 */
export const PERSON_FACTS_MAX_IDS = 1000;

export interface PersonFactsOrganization {
  name: string | null;
  domain: string | null;
  industry: string | null;
  employees: number | null;
  city: string | null;
  state: string | null;
  country: string | null;
  keywords: string[];
}

export interface PersonFacts {
  apolloPersonId: string;
  known: boolean;
  revealedAt: string | null;
  title: string | null;
  headline: string | null;
  seniority: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  organization: PersonFactsOrganization | null;
}

export interface PersonFactsRow {
  apollo_person_id: string;
  created_at: Date | string;
  title: string | null;
  headline: string | null;
  seniority: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  organization_name: string | null;
  organization_domain: string | null;
  organization_industry: string | null;
  organization_size: string | null;
  organization_city: string | null;
  organization_state: string | null;
  organization_country: string | null;
  organization_keywords: unknown;
}

const blankToNull = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

function toEmployees(size: string | null): number | null {
  const s = blankToNull(size);
  if (!s || !/^\d+$/.test(s)) return null;
  return Number(s);
}

function toKeywords(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((k): k is string => typeof k === "string" && k.trim() !== "").map((k) => k.trim());
}

const unknownPerson = (apolloPersonId: string): PersonFacts => ({
  apolloPersonId,
  known: false,
  revealedAt: null,
  title: null,
  headline: null,
  seniority: null,
  city: null,
  state: null,
  country: null,
  organization: null,
});

/** Pure: one answer per asked id, request order; ids with no row are `known: false`. */
export function shapePersonFacts(askedIds: string[], rows: PersonFactsRow[]): PersonFacts[] {
  const byId = new Map(rows.map((r) => [r.apollo_person_id, r]));
  return askedIds.map((id) => {
    const r = byId.get(id);
    if (!r) return unknownPerson(id);
    const org: PersonFactsOrganization = {
      name: blankToNull(r.organization_name),
      domain: blankToNull(r.organization_domain),
      industry: blankToNull(r.organization_industry),
      employees: toEmployees(r.organization_size),
      city: blankToNull(r.organization_city),
      state: blankToNull(r.organization_state),
      country: blankToNull(r.organization_country),
      keywords: toKeywords(r.organization_keywords),
    };
    const orgKnown = Object.entries(org).some(([k, v]) => (k === "keywords" ? (v as string[]).length > 0 : v !== null));
    return {
      apolloPersonId: id,
      known: true,
      revealedAt: (r.created_at instanceof Date ? r.created_at : new Date(r.created_at)).toISOString(),
      title: blankToNull(r.title),
      headline: blankToNull(r.headline),
      seniority: blankToNull(r.seniority),
      city: blankToNull(r.city),
      state: blankToNull(r.state),
      country: blankToNull(r.country),
      organization: orgKnown ? org : null,
    };
  });
}

export async function findPersonFacts(apolloPersonIds: string[]): Promise<PersonFacts[]> {
  const asked = normalizeAskedIds(apolloPersonIds);
  if (asked.length === 0) return [];
  // idx_enrichments_person_id. Per id: the latest reveal that carries a title or
  // an employer, else the latest reveal at all.
  const rows = (await db.execute(sql`
    SELECT DISTINCT ON (e.apollo_person_id)
           e.apollo_person_id, e.created_at, e.title, e.headline, e.seniority, e.city, e.state, e.country,
           e.organization_name, e.organization_domain, e.organization_industry, e.organization_size,
           e.organization_city, e.organization_state, e.organization_country, e.organization_keywords
      FROM apollo_people_enrichments e
     WHERE e.apollo_person_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(asked)}::jsonb))
     ORDER BY e.apollo_person_id,
              (nullif(btrim(e.title), '') IS NOT NULL OR nullif(btrim(e.organization_name), '') IS NOT NULL) DESC,
              e.created_at DESC
  `)) as unknown as PersonFactsRow[];
  return shapePersonFacts(asked, rows);
}
