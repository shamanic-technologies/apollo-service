/**
 * The cheap email paths, in order, for a person whose full name and company
 * domain we know (APOLLO-ZERO-COST-1119): our stock ($0), a guess from the
 * company's format (one check), treg find (~0.57c). Returns a DELIVERABLE
 * address with its verdict, or null so the caller can go on to its last resort.
 */

import type { VerificationContext, EmailVerificationResult } from "./email-verification.js";
import { findGuessedEmail, findStockEmailFor, verifyStockEmail, type StockEmail } from "./email-stock.js";
import { executeEmailFind, type EmailFindContext } from "./email-find-run.js";

export type FreeEmail =
  | { kind: "stock"; email: string; verification: EmailVerificationResult; stockSource: StockEmail["source"] }
  | { kind: "guess"; email: string; verification: EmailVerificationResult }
  | { kind: "treg"; email: string; verification: EmailVerificationResult; findingId: string };

export async function freeEmailFor(
  person: { firstName: string; lastName: string; linkedinUrl: string | null; domain: string },
  verifyCtx: VerificationContext,
  findCtx: EmailFindContext
): Promise<FreeEmail | null> {
  const stock = await findStockEmailFor({ linkedinUrl: person.linkedinUrl, firstName: person.firstName, lastName: person.lastName, domain: person.domain });
  if (stock) {
    const verification = await verifyStockEmail(stock.email, verifyCtx);
    if (verification.deliverable) return { kind: "stock", email: stock.email, verification, stockSource: stock.source };
  }
  const guessed = await findGuessedEmail({ firstName: person.firstName, lastName: person.lastName, domain: person.domain }, verifyCtx);
  if (guessed) return { kind: "guess", email: guessed.email, verification: guessed.verification };
  const found = await executeEmailFind(findCtx, "treg", undefined, {
    linkedinUrl: person.linkedinUrl ?? undefined,
    firstName: person.firstName,
    lastName: person.lastName,
    domain: person.domain,
  });
  if (found.status !== 200) return null;
  const body = found.body as { findingId: string; status: string; email: string | null; emailVerification: EmailVerificationResult | null };
  if (body.status !== "found" || !body.email || !body.emailVerification?.deliverable) return null;
  return { kind: "treg", email: body.email, verification: body.emailVerification, findingId: body.findingId };
}
