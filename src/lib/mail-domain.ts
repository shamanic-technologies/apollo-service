/**
 * Does this domain accept mail? Our own DNS answer, used to overrule the
 * verifier when it claims a domain does not exist (DNE-FALSE-INVALID-1015).
 *
 * The BounceVerify actor answers `status: invalid, reason: "Domain does not
 * exist", domain_exists: false, mx_found: false` for any domain without an A
 * record, even when the domain publishes MX records (reproduced 2026-10-15 on
 * definitejobsgroup.co.uk and colpal.com). Of the 486 prod rows carrying that
 * reason, 413 sat on a domain with MX records. A web-less mail domain is
 * common (a company whose site lives elsewhere), so the actor's domain check
 * is not evidence that mail cannot be delivered.
 */

import { Resolver } from "node:dns/promises";

/** DNS codes that mean "no MX here", a real answer (the domain or the record set does not exist). */
const NO_MX_CODES = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"]);

export class MailDomainLookupError extends Error {
  constructor(domain: string, cause: unknown) {
    super(`MX lookup for ${domain} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "MailDomainLookupError";
  }
}

/**
 * true = the domain publishes at least one usable MX record. A "null MX"
 * (RFC 7505, exchange "" or ".") says the domain accepts NO mail → false.
 * A lookup that cannot answer (timeout, SERVFAIL) throws: no answer is not
 * "no MX".
 */
export async function domainHasMx(domain: string): Promise<boolean> {
  const resolver = new Resolver({ timeout: 3_000, tries: 2 });
  try {
    const records = await resolver.resolveMx(domain);
    return records.some((r) => r.exchange !== "" && r.exchange !== ".");
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code && NO_MX_CODES.has(code)) return false;
    throw new MailDomainLookupError(domain, err);
  }
}
