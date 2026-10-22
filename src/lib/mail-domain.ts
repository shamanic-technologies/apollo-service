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

import { errorMessage } from "./db-error.js";
import { Resolver } from "node:dns/promises";

/** DNS codes that mean "no MX here", a real answer (the domain or the record set does not exist). */
const NO_MX_CODES = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"]);

/**
 * SERVFAIL: the recursive resolver could not get an answer for THIS name. Two
 * causes call for opposite answers: the domain's own DNS is broken (lame or
 * broken delegation, DNSSEC bogus; no sender can resolve it either) or our
 * resolver is sick (it SERVFAILs everything). APOLLO-SERVFAIL-POISON-1021:
 * teamquickenlends.com and lynxgrowthagency.com SERVFAILed for days and one
 * such address 502'd every newsletter slice it sat in.
 */
const SERVFAIL_CODE = "ESERVFAIL";

/**
 * Domains whose MX always resolves. A SERVFAIL counts as the DOMAIN's fault
 * only when the same resolver answers one of these at that moment.
 */
export const CONTROL_MX_DOMAINS = ["gmail.com", "outlook.com"] as const;

export class MailDomainLookupError extends Error {
  constructor(domain: string, cause: unknown) {
    super(`MX lookup for ${domain} failed: ${errorMessage(cause)}`);
    this.name = "MailDomainLookupError";
  }
}

function newResolver(): Resolver {
  return new Resolver({ timeout: 3_000, tries: 2 });
}

/** Our resolver answers a known-good domain right now. */
async function resolverIsHealthy(resolver: Resolver): Promise<boolean> {
  const answers = await Promise.allSettled(CONTROL_MX_DOMAINS.map((d) => resolver.resolveMx(d)));
  return answers.some((a) => a.status === "fulfilled" && a.value.length > 0);
}

/**
 * true = the domain publishes at least one usable MX record. A "null MX"
 * (RFC 7505, exchange "" or ".") says the domain accepts NO mail → false.
 * A SERVFAIL while our resolver answers the control domains = the domain's own
 * DNS is broken, no MTA can route mail there → false. A lookup that cannot
 * answer otherwise (timeout, SERVFAIL on everything, refused) throws: no
 * answer is not "no MX".
 */
export async function domainHasMx(domain: string): Promise<boolean> {
  const resolver = newResolver();
  try {
    const records = await resolver.resolveMx(domain);
    return records.some((r) => r.exchange !== "" && r.exchange !== ".");
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code && NO_MX_CODES.has(code)) return false;
    if (code === SERVFAIL_CODE && (await resolverIsHealthy(resolver))) {
      console.warn(`[Apollo Service] mail_domain.servfail_domain_broken domain=${domain}`);
      return false;
    }
    throw new MailDomainLookupError(domain, err);
  }
}
