/**
 * Daily series of WHERE each work email we served came from (APOLLO-ZERO-COST-1119:
 * "Apollo last"), for dashboard v2 Monitoring. Read from the bronze rows every path
 * already writes, never a new counter:
 * - apolloReveals: an Apollo reveal that returned an email (`apollo_people_enrichments`).
 * - tregFinds: a treg / Explee find that returned an email (`email_findings` found).
 * - stockReuses: a free-source / QuickEnrich / unmasked person whose address was already
 *   in our stock (`email_verifications` source `stock:*`).
 * - formatGuesses: a guessed address checked valid (source `pattern-guess:*`, verdict valid).
 * - freeSourcePeople: people the free sources (Leadsforge, Dropleads) returned that day.
 * `apolloShare` = apolloReveals / every email served that day; null on a day with none.
 */

import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

export interface EmailSourcesDay {
  day: string;
  apolloReveals: number;
  tregFinds: number;
  stockReuses: number;
  formatGuesses: number;
  freeSourcePeople: number;
  apolloShare: number | null;
}

export function apolloShareOf(d: Omit<EmailSourcesDay, "apolloShare" | "day" | "freeSourcePeople">): number | null {
  const total = d.apolloReveals + d.tregFinds + d.stockReuses + d.formatGuesses;
  return total === 0 ? null : d.apolloReveals / total;
}

export async function readEmailSourcesDaily(days: number): Promise<EmailSourcesDay[]> {
  const rows = (await db.execute(sql`
    WITH d AS (SELECT generate_series((now() AT TIME ZONE 'UTC')::date - (${days}::int - 1), (now() AT TIME ZONE 'UTC')::date, '1 day')::date AS day),
    a AS (SELECT (created_at AT TIME ZONE 'UTC')::date AS day, count(*) n FROM apollo_people_enrichments
           WHERE created_at >= now() - make_interval(days => ${days}) AND email IS NOT NULL AND enrichment_run_id IS NOT NULL GROUP BY 1),
    t AS (SELECT (created_at AT TIME ZONE 'UTC')::date AS day, count(*) n FROM email_findings
           WHERE created_at >= now() - make_interval(days => ${days}) AND status = 'found' GROUP BY 1),
    s AS (SELECT (verified_at AT TIME ZONE 'UTC')::date AS day, count(DISTINCT lower(email)) n FROM email_verifications
           WHERE verified_at >= now() - make_interval(days => ${days}) AND source LIKE 'stock:%' GROUP BY 1),
    g AS (SELECT (verified_at AT TIME ZONE 'UTC')::date AS day, count(DISTINCT lower(email)) n FROM email_verifications
           WHERE verified_at >= now() - make_interval(days => ${days}) AND source LIKE 'pattern-guess:%' AND verdict = 'valid' GROUP BY 1),
    f AS (SELECT (called_at AT TIME ZONE 'UTC')::date AS day, coalesce(sum(rows_returned), 0) n FROM free_source_searches
           WHERE called_at >= now() - make_interval(days => ${days}) AND error IS NULL GROUP BY 1)
    SELECT d.day::text AS day, coalesce(a.n,0)::int a, coalesce(t.n,0)::int t, coalesce(s.n,0)::int s, coalesce(g.n,0)::int g, coalesce(f.n,0)::int f
      FROM d LEFT JOIN a USING (day) LEFT JOIN t USING (day) LEFT JOIN s USING (day) LEFT JOIN g USING (day) LEFT JOIN f USING (day)
     ORDER BY d.day`)) as unknown as Array<{ day: string; a: number; t: number; s: number; g: number; f: number }>;
  return rows.map((r) => {
    const base = { apolloReveals: Number(r.a), tregFinds: Number(r.t), stockReuses: Number(r.s), formatGuesses: Number(r.g) };
    return { day: r.day, ...base, freeSourcePeople: Number(r.f), apolloShare: apolloShareOf(base) };
  });
}
