/**
 * Our STOCK of work emails (APOLLO-ZERO-COST-1119, owner 2026-11-19: Apollo
 * last, every free path first). Before a QuickEnrich person's email is bought
 * from treg, look for an address a paid task of ours ALREADY returned for the
 * same person, any org: an Apollo reveal (`apollo_people_enrichments`, the
 * fleet-wide reveal cache already serves any org) or a found email finding
 * (`email_findings`, any vendor / preset). Measured 2026-11-19: 1,056 of the
 * 1,774 QuickEnrich people in silver had one.
 *
 * Free: no vendor call, no cost declared (the earlier payer stays the payer,
 * like a reveal cache hit; /internal/acquisition-costs prices the reuse). The
 * address is still verified like every reveal (30-day verdict reuse applies).
 */

import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { canonicalLinkedinUrl } from "./quickenrich.js";
import { normalizeDomain, personKeyOf } from "./email-finders.js";
import { verifyRevealedEmail, type EmailVerificationResult, type VerificationContext } from "./email-verification.js";

export interface StockEmail {
  email: string;
  /** Which of our paid tables returned it. */
  source: "apollo-reveal" | "email-finding";
}

/** The two spellings our tables key a LinkedIn person by; null without a /in/ profile URL. */
export function stockLinkedinKeys(linkedinUrl: string | null | undefined): { apolloUrl: string; findingKey: string } | null {
  if (!linkedinUrl || !/linkedin\.com\/in\//i.test(linkedinUrl)) return null;
  return {
    apolloUrl: canonicalLinkedinUrl(linkedinUrl),
    findingKey: personKeyOf({ linkedinUrl: linkedinUrl.trim().replace(/\/+$/, "") }),
  };
}

/** The latest address our paid tasks returned for this LinkedIn person, or null. */
export async function findStockEmail(person: { employee_linkedin?: string | null }): Promise<StockEmail | null> {
  return findStockEmailFor({ linkedinUrl: person.employee_linkedin ?? null });
}

/**
 * Same stock, for a person known by LinkedIn and/or full name + company domain
 * (Leadsforge rows carry no LinkedIn). The name match is EXACT on first name,
 * last name and domain, case-insensitive, never a fuzzy guess.
 */
export async function findStockEmailFor(person: { linkedinUrl: string | null; firstName?: string | null; lastName?: string | null; domain?: string | null }): Promise<StockEmail | null> {
  const byLinkedin = await findStockByLinkedin(person.linkedinUrl);
  if (byLinkedin) return byLinkedin;
  const first = person.firstName?.trim().toLowerCase();
  const last = person.lastName?.trim().toLowerCase();
  const domain = normalizeDomain(person.domain ?? "");
  if (!first || !last || !domain) return null;
  const reveal = await db.execute(sql`
    SELECT email FROM apollo_people_enrichments
    WHERE lower(organization_domain) = ${domain} AND lower(first_name) = ${first} AND lower(last_name) = ${last}
      AND email IS NOT NULL AND btrim(email) <> ''
    ORDER BY created_at DESC LIMIT 1`);
  const revealed = (reveal as unknown as Array<{ email: string }>)[0];
  if (revealed) return { email: revealed.email.trim(), source: "apollo-reveal" };
  const finding = await db.execute(sql`
    SELECT email FROM email_findings
    WHERE person_key = ${personKeyOf({ firstName: first, lastName: last, domain })} AND status = 'found' AND email IS NOT NULL AND btrim(email) <> ''
    ORDER BY created_at DESC LIMIT 1`);
  const found = (finding as unknown as Array<{ email: string }>)[0];
  return found ? { email: found.email.trim(), source: "email-finding" } : null;
}

async function findStockByLinkedin(linkedinUrl: string | null): Promise<StockEmail | null> {
  const keys = stockLinkedinKeys(linkedinUrl);
  if (!keys) return null;
  const reveal = await db.execute(sql`
    SELECT email FROM apollo_people_enrichments
    WHERE lower(linkedin_url) = ${keys.apolloUrl} AND email IS NOT NULL AND btrim(email) <> ''
    ORDER BY created_at DESC LIMIT 1`);
  const revealed = (reveal as unknown as Array<{ email: string }>)[0];
  if (revealed) return { email: revealed.email.trim(), source: "apollo-reveal" };
  const finding = await db.execute(sql`
    SELECT email FROM email_findings
    WHERE person_key = ${keys.findingKey} AND status = 'found' AND email IS NOT NULL AND btrim(email) <> ''
    ORDER BY created_at DESC LIMIT 1`);
  const found = (finding as unknown as Array<{ email: string }>)[0];
  return found ? { email: found.email.trim(), source: "email-finding" } : null;
}

/** Verify a stock address exactly like a reveal (same bronze, same 30-day reuse). */
export function verifyStockEmail(email: string, ctx: VerificationContext): Promise<EmailVerificationResult> {
  return verifyRevealedEmail(email, ctx);
}
