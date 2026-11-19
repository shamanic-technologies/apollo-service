/**
 * Guess a work email from the FORMAT the company already uses (APOLLO-ZERO-COST-1119:
 * every cheaper path before a paid find). Our stock holds ~67k revealed addresses with
 * their owner's name; a company's format is read from the addresses we already hold
 * at that mail domain, applied to the new person's name, then CHECKED like every
 * reveal. Only a `valid` verdict is served; anything else falls through to treg.
 *
 * Measured on prod 2026-11-19, leave-one-out over every domain where we hold ≥ 2
 * named addresses (22,808 people): the dominant format of the OTHER addresses
 * predicted the held one 75.5 % of the time (16,048 / 21,258 with a readable format).
 * Formats seen, most common first: first, first.last, flast, firstlast, firstl.
 */

import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

export const EMAIL_FORMATS = {
  "first.last": (f: string, l: string) => `${f}.${l}`,
  flast: (f: string, l: string) => `${f[0]}${l}`,
  first: (f: string) => f,
  firstlast: (f: string, l: string) => `${f}${l}`,
  "f.last": (f: string, l: string) => `${f[0]}.${l}`,
  first_last: (f: string, l: string) => `${f}_${l}`,
  firstl: (f: string, l: string) => `${f}${l[0]}`,
  last: (_f: string, l: string) => l,
  "first.l": (f: string, l: string) => `${f}.${l[0]}`,
  "last.first": (f: string, l: string) => `${l}.${f}`,
  lastf: (f: string, l: string) => `${l}${f[0]}`,
} as const;
export type EmailFormat = keyof typeof EMAIL_FORMATS;

/** A name part as it appears in an address: accents stripped, letters only, lower-case. */
export function namePart(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

/** The format an address's local part follows for this name, or null when none does. */
export function formatOf(firstName: string, lastName: string, email: string): EmailFormat | null {
  const f = namePart(firstName);
  const l = namePart(lastName);
  if (!f || !l) return null;
  const local = email.split("@")[0].toLowerCase();
  for (const [name, fn] of Object.entries(EMAIL_FORMATS) as Array<[EmailFormat, (f: string, l: string) => string]>) {
    if (fn(f, l) === local) return name;
  }
  return null;
}

/** The format most addresses of a domain follow; null when none is readable. Ties keep the first seen. */
export function dominantFormat(samples: Array<{ firstName: string; lastName: string; email: string }>): EmailFormat | null {
  const counts = new Map<EmailFormat, number>();
  for (const s of samples) {
    const fmt = formatOf(s.firstName, s.lastName, s.email);
    if (fmt) counts.set(fmt, (counts.get(fmt) ?? 0) + 1);
  }
  let best: EmailFormat | null = null;
  for (const [fmt, n] of counts) if (best === null || n > (counts.get(best) ?? 0)) best = fmt;
  return best;
}

/** The address this person would have under the format; null when the name has no letters. */
export function guessAddress(firstName: string, lastName: string, format: EmailFormat, domain: string): string | null {
  const f = namePart(firstName);
  const l = namePart(lastName);
  if (!f || !l || !domain) return null;
  return `${EMAIL_FORMATS[format](f, l)}@${domain.toLowerCase()}`;
}

/** Named addresses we already hold at this mail domain (latest 50), from our paid reveals. */
export async function knownAddressesAt(domain: string): Promise<Array<{ firstName: string; lastName: string; email: string }>> {
  const rows = (await db.execute(sql`
    SELECT first_name, last_name, lower(btrim(email)) AS email
      FROM apollo_people_enrichments
     WHERE lower(organization_domain) = ${domain}
       AND lower(split_part(btrim(email), '@', 2)) = ${domain}
       AND first_name IS NOT NULL AND last_name IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 50`)) as unknown as Array<{ first_name: string; last_name: string; email: string }>;
  return rows.map((r) => ({ firstName: r.first_name, lastName: r.last_name, email: r.email }));
}
