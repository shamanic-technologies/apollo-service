/**
 * Email finders other than Apollo: treg.to (a routed hub over ~20 providers)
 * and Explee. Each call is recorded verbatim (bronze) and normalised into one
 * finding per (vendor, preset, person) (silver) so it compares to an Apollo
 * reveal.
 *
 * This module only speaks to the vendors and normalises what they answer. The
 * route owns identity, idempotency, persistence and the cost protocol.
 *
 * Verified against the live docs on 2026-09-25:
 * - treg: https://treg.to/llms.txt + GET /catalog/endpoints/treg.people.email.find
 *   `POST /call/treg.people.email.find`, header `X-Treg-Token`. The exact
 *   charge is the response header `X-Treg-Cost-Micro` (integer micro-USD),
 *   never anything in the body. A miss (`output.email == null`) is free. A
 *   routed call whose async child is still running answers 202 with
 *   `charged_micro: null` — it may still charge, so it must NOT be retried.
 * - Explee: https://api.explee.com/public/api/openapi.json
 *   `POST /public/api/v1/enrich/email`, header `X-API-Key`, body
 *   `{first_name, last_name, company_domain, preset}`. `meta.credits_charged`
 *   is what was billed (0 when not found). basic = 1.5 credits, premium = 5.
 */

export type EmailFinderVendor = "treg" | "explee";
export type ExpleePreset = "basic" | "premium";

/** treg has no preset; the silver key still needs one, so it is named. */
export const TREG_PRESET = "routed";

/** Catalogue names (costs-service seed, KevinLourd/treg-explee-cost-rows). */
export const TREG_COST_NAME = "treg-micro-usd";
export const EXPLEE_COST_NAME = "explee-credit";

/**
 * Ceiling on one treg routed find, in micro-USD: $0.01, the benchmark's target
 * price per person. Sent to treg as `X-Treg-Route-Max-Cost`, which treg
 * applies PER CHILD and CUMULATIVELY — verified live 2026-09-25: every child
 * priced above it is `skipped: "would exceed max cost"` and never called, so no
 * lookup can cost more than this. That makes it a TRUE worst case to provision.
 * The plan it leaves (2026-09-25): quickenrich $0.004834, trykitt $0.005,
 * aiark $0.005267 (LinkedIn only), tomba $0.0089 (name or LinkedIn), moltsets
 * $0.01. Everything dearer (findymail, prospeo, hunter, contactout $0.15, …)
 * is skipped.
 */
export const TREG_MAX_COST_MICRO = 10_000;

/**
 * Providers never tried, sent as `X-Treg-Route-Exclude` (comma list). treg
 * matches it on the PROVIDER — an endpoint id there is silently ignored
 * (verified live 2026-09-25). leadmagic serves `leadmagic.x.personal-email-finder`
 * (gmail/yahoo/hotmail, useless for B2B); its work finder is $0.025, above the
 * ceiling anyway, so excluding the provider loses nothing.
 */
export const TREG_EXCLUDED_PROVIDERS = ["leadmagic"] as const;

/** Explee's documented per-hit price, per preset, in credits. */
export const EXPLEE_PRESET_CREDITS: Record<ExpleePreset, number> = { basic: 1.5, premium: 5 };

export const TREG_FIND_URL = "https://treg.to/call/treg.people.email.find";
export const EXPLEE_FIND_URL = "https://api.explee.com/public/api/v1/enrich/email";

/** Explee documents a 90s server timeout; treg polls an async child for up to 60s. */
const VENDOR_TIMEOUT_MS = 100_000;

export interface FindPerson {
  apolloPersonId?: string;
  firstName?: string;
  lastName?: string;
  domain?: string;
  linkedinUrl?: string;
}

/** What came back, both raw (for bronze) and normalised (for silver). */
export interface VendorFindResult {
  /** "found" | "not_found" | "pending" (treg async child still running). */
  outcome: "found" | "not_found" | "pending";
  email: string | null;
  vendorMailboxStatus: string | null;
  mailboxStatus: MailboxStatus | null;
  underlyingProvider: string | null;
  /** Vendor-reported charge in its own unit; null only for a pending treg call. */
  chargedQuantity: number | null;
  /** An address the vendor returned but that is not a WORK email (kept for the record, never served). */
  rejectedEmail: string | null;
  rejectionReason: EmailRejectionReason | null;
  exchange: VendorExchange;
}

export type EmailRejectionReason = "personal_email";

/**
 * Consumer mailbox providers: an address there is a person's private inbox,
 * not their work one. A positive fingerprint only — an unknown domain is
 * presumed to be a company's.
 */
export const PERSONAL_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com",
  "yahoo.com", "ymail.com", "rocketmail.com", "yahoo.co.uk", "yahoo.fr", "yahoo.ca", "yahoo.de", "yahoo.es", "yahoo.it", "yahoo.com.au", "yahoo.co.in",
  "hotmail.com", "hotmail.co.uk", "hotmail.fr", "hotmail.de", "hotmail.es", "hotmail.it",
  "outlook.com", "outlook.fr", "live.com", "live.co.uk", "live.fr", "msn.com", "passport.com",
  "aol.com", "aim.com", "icloud.com", "me.com", "mac.com",
  "protonmail.com", "proton.me", "pm.me", "tutanota.com", "fastmail.com", "hey.com",
  "gmx.com", "gmx.net", "gmx.de", "gmx.fr", "web.de", "mail.com", "yandex.com", "yandex.ru", "mail.ru", "zoho.com",
  "comcast.net", "att.net", "sbcglobal.net", "verizon.net", "bellsouth.net", "cox.net", "charter.net",
  "earthlink.net", "optonline.net", "frontier.com", "windstream.net", "juno.com", "netzero.net",
  "orange.fr", "wanadoo.fr", "free.fr", "laposte.net", "sfr.fr", "neuf.fr", "libero.it", "btinternet.com",
  "qq.com", "163.com", "126.com", "rediffmail.com",
]);

/**
 * Is this a PERSONAL address rather than a work one? True when it sits on a
 * consumer mailbox provider, unless that provider IS the person's employer
 * (someone who works at aol.com has a work address there).
 */
export function isPersonalEmail(email: string, companyDomain?: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!PERSONAL_EMAIL_DOMAINS.has(domain)) return false;
  return normalizeDomain(companyDomain) !== domain;
}

/**
 * A found address that is not a work email is not a finding: the outcome
 * becomes `not_found` and the address is kept aside as `rejectedEmail`. The
 * vendor's charge is untouched — it was billed, and the cost stays exact.
 * A child whose own name says it finds PERSONAL emails is rejected whatever
 * the address looks like.
 */
export function rejectNonWorkEmail(result: VendorFindResult, person: FindPerson): VendorFindResult {
  if (result.outcome !== "found" || !result.email) return result;
  const personalChild = /personal/i.test(result.underlyingProvider ?? "");
  if (!personalChild && !isPersonalEmail(result.email, person.domain)) return result;
  return {
    ...result,
    outcome: "not_found",
    email: null,
    vendorMailboxStatus: null,
    mailboxStatus: null,
    rejectedEmail: result.email,
    rejectionReason: "personal_email",
  };
}

/** One HTTP exchange, as it will be written to bronze. */
export interface VendorExchange {
  requestUrl: string;
  requestBody: Record<string, unknown>;
  httpStatus: number | null;
  responseHeaders: Record<string, string> | null;
  responseBody: unknown;
  durationMs: number;
}

/**
 * A vendor call that did not produce a usable answer. Carries the exchange so
 * the failure lands in bronze too. `mayHaveCharged` is true only when the
 * vendor may have billed us despite the failure — the hold is then kept rather
 * than cancelled, because releasing it would under-record real spend.
 */
export class EmailFinderVendorError extends Error {
  readonly vendor: EmailFinderVendor;
  readonly exchange: VendorExchange;
  readonly mayHaveCharged: boolean;
  constructor(vendor: EmailFinderVendor, message: string, exchange: VendorExchange, mayHaveCharged = false) {
    super(message);
    this.name = "EmailFinderVendorError";
    this.vendor = vendor;
    this.exchange = exchange;
    this.mayHaveCharged = mayHaveCharged;
  }
}

export type MailboxStatus = "valid" | "catch_all" | "invalid" | "unverified" | "unknown";

/**
 * The vendor's own word for the mailbox check, folded onto one vocabulary so
 * treg and Explee compare. The verbatim word always survives beside it.
 * `catch_all_valid` (Explee: a catch-all domain whose mailbox it validated
 * anyway) folds to `catch_all` — a catch-all domain accepts every address, so
 * no SMTP check on it is proof of delivery.
 */
export function normalizeMailboxStatus(raw: string | null | undefined): MailboxStatus | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!s) return null;
  if (s.includes("catch_all") || s.includes("accept_all") || s === "acceptall" || s === "catchall") return "catch_all";
  if (["valid", "verified", "deliverable", "ok", "safe"].includes(s)) return "valid";
  if (["invalid", "undeliverable", "bounced", "bounce"].includes(s)) return "invalid";
  if (["unverified", "not_verified"].includes(s)) return "unverified";
  return "unknown";
}

/**
 * The silver identity of a person. An Apollo person id wins (it is what the
 * benchmark and human-service hold); otherwise the LinkedIn URL; otherwise
 * name + domain. Case- and whitespace-insensitive so a re-request with the
 * same person spelled differently still hits the existing row.
 */
export function personKeyOf(person: FindPerson): string {
  if (person.apolloPersonId?.trim()) return `apollo:${person.apolloPersonId.trim()}`;
  if (person.linkedinUrl?.trim()) {
    const url = person.linkedinUrl.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
    return `linkedin:${url}`;
  }
  const norm = (v: string | undefined) => (v ?? "").trim().toLowerCase();
  return `name:${norm(person.firstName)}|${norm(person.lastName)}|${normalizeDomain(person.domain)}`;
}

export function normalizeDomain(domain: string | undefined): string {
  return (domain ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

interface Posted {
  exchange: VendorExchange;
  response: Response | null;
  networkError: Error | null;
}

async function post(url: string, headers: Record<string, string>, body: Record<string, unknown>): Promise<Posted> {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(VENDOR_TIMEOUT_MS),
    });
    const responseBody = await readBody(response);
    return {
      response,
      networkError: null,
      exchange: {
        requestUrl: url,
        requestBody: body,
        httpStatus: response.status,
        responseHeaders: headersToObject(response.headers),
        responseBody,
        durationMs: Date.now() - started,
      },
    };
  } catch (err) {
    return {
      response: null,
      networkError: err instanceof Error ? err : new Error(String(err)),
      exchange: {
        requestUrl: url,
        requestBody: body,
        httpStatus: null,
        responseHeaders: null,
        responseBody: null,
        durationMs: Date.now() - started,
      },
    };
  }
}

function vendorErrorMessage(vendor: EmailFinderVendor, exchange: VendorExchange): string {
  const body = exchange.responseBody as Record<string, unknown> | null;
  const detail = body && typeof body === "object" ? (body.detail ?? body.error ?? body.message ?? body._raw) : null;
  const detailText = detail === null || detail === undefined ? "" : typeof detail === "string" ? detail : JSON.stringify(detail);
  return `${vendor} email find failed: HTTP ${exchange.httpStatus}${detailText ? ` - ${detailText.slice(0, 500)}` : ""}`;
}

// ─── treg ────────────────────────────────────────────────────────────────────

export function buildTregBody(person: FindPerson): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (person.firstName?.trim()) body.first_name = person.firstName.trim();
  if (person.lastName?.trim()) body.last_name = person.lastName.trim();
  if (person.firstName?.trim() && person.lastName?.trim()) body.full_name = `${person.firstName.trim()} ${person.lastName.trim()}`;
  const domain = normalizeDomain(person.domain);
  if (domain) body.domain = domain;
  if (person.linkedinUrl?.trim()) body.linkedin_url = person.linkedinUrl.trim();
  return body;
}

/**
 * treg's contract reports the mailbox check only as `output.verified` (bool),
 * but the child's own word rides in `raw` — verified live 2026-09-25: a hit
 * with `output.verified: false` carried `raw.status: "catch_all"`. A word that
 * names a mailbox state wins over the bool (catch_all is exactly what the bool
 * hides); a word that does not (`raw.status: "success"`) is ignored.
 */
export function tregVendorMailboxStatus(output: Record<string, unknown> | null, raw: Record<string, unknown> | null): string | null {
  const words = [
    output?.status,
    output?.email_status,
    output?.verification_status,
    raw?.email_status,
    raw?.verification_status,
    raw?.status,
    raw?.verification,
    raw?.result,
  ]
    .map(str)
    .filter((w): w is string => w !== null);
  const named = words.find((w) => {
    const n = normalizeMailboxStatus(w);
    return n !== null && n !== "unknown";
  });
  if (named) return named;
  if (output?.verified === true) return "verified";
  // treg's contract: only `verified: true` means the mailbox was checked. A
  // child that sends no flag at all (live: quickenrich) made no claim, which
  // treg itself reports as "not confirmed deliverable (verified != true)".
  return words[0] ?? "unverified";
}

/**
 * The charge treg reports, in integer micro-USD. The header is the contract;
 * `_treg.charged_micro` is the same figure in the body and is read only when
 * the header is absent. Null when neither is present.
 */
function tregChargedMicro(exchange: VendorExchange): number | null {
  const header = exchange.responseHeaders?.["x-treg-cost-micro"];
  if (header !== undefined && header !== null && String(header).trim() !== "") {
    const n = Number(header);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const meta = (exchange.responseBody as { _treg?: { charged_micro?: unknown } } | null)?._treg;
  if (meta && typeof meta.charged_micro === "number" && Number.isFinite(meta.charged_micro)) return meta.charged_micro;
  return null;
}

/**
 * `token` is a treg IDENTITY token (team-scoped login), so every call also
 * names the team: `X-Treg-Org` (key-service provider `treg-org`).
 */
export async function findWithTreg(token: string, org: string, person: FindPerson, idempotencyKey: string): Promise<VendorFindResult> {
  const body = buildTregBody(person);
  const { exchange, response, networkError } = await post(
    TREG_FIND_URL,
    {
      "X-Treg-Token": token,
      "X-Treg-Org": org,
      // A true ceiling: every child priced above it is skipped, never called.
      "X-Treg-Route-Max-Cost": (TREG_MAX_COST_MICRO / 1_000_000).toFixed(6),
      // Work-email partners only: the personal-email finder's provider is never tried.
      "X-Treg-Route-Exclude": TREG_EXCLUDED_PROVIDERS.join(","),
      // A retry of a call whose answer was lost is replayed, never re-billed.
      "Idempotency-Key": idempotencyKey,
    },
    body
  );

  if (networkError || !response) {
    // The request may have reached treg and been billed before the answer was
    // lost; keep the hold. The same Idempotency-Key makes a retry a free replay.
    throw new EmailFinderVendorError("treg", `treg email find failed: ${networkError?.message ?? "no response"}`, exchange, true);
  }
  if (response.status !== 200 && response.status !== 202) {
    // treg relays a provider's 4xx/5xx unchanged and charges nothing for it.
    throw new EmailFinderVendorError("treg", vendorErrorMessage("treg", exchange), exchange);
  }

  const parsed = (exchange.responseBody ?? {}) as {
    output?: Record<string, unknown> | null;
    raw?: Record<string, unknown> | null;
    _treg?: { served_by?: unknown };
  };
  const underlyingProvider = str(exchange.responseHeaders?.["x-treg-served-by"]) ?? str(parsed._treg?.served_by);

  if (response.status === 202) {
    return {
      outcome: "pending",
      email: null,
      vendorMailboxStatus: null,
      mailboxStatus: null,
      underlyingProvider,
      chargedQuantity: null,
      rejectedEmail: null,
      rejectionReason: null,
      exchange,
    };
  }

  const output = parsed.output && typeof parsed.output === "object" ? parsed.output : null;
  const email = str(output?.email);
  const charged = tregChargedMicro(exchange);

  if (charged === null) {
    if (!email) {
      // A miss is free by contract; an absent charge on a miss is zero.
      return { outcome: "not_found", email: null, vendorMailboxStatus: null, mailboxStatus: null, underlyingProvider, chargedQuantity: 0, rejectedEmail: null, rejectionReason: null, exchange };
    }
    throw new EmailFinderVendorError(
      "treg",
      "treg returned an email without reporting its charge (no X-Treg-Cost-Micro header, no _treg.charged_micro) — cannot declare the cost",
      exchange,
      true
    );
  }

  const raw = parsed.raw && typeof parsed.raw === "object" ? parsed.raw : null;
  const vendorMailboxStatus = email ? tregVendorMailboxStatus(output, raw) : null;
  if (charged > TREG_MAX_COST_MICRO) {
    // treg promised not to; the charge is still declared exactly, but loudly.
    console.error(`[Apollo Service][treg] find charged ${charged} micro-USD, above the ${TREG_MAX_COST_MICRO} ceiling (served by ${underlyingProvider})`);
  }
  return rejectNonWorkEmail(
    {
      outcome: email ? "found" : "not_found",
      email,
      vendorMailboxStatus,
      mailboxStatus: normalizeMailboxStatus(vendorMailboxStatus),
      underlyingProvider,
      chargedQuantity: charged,
      rejectedEmail: null,
      rejectionReason: null,
      exchange,
    },
    person
  );
}

// ─── Explee ──────────────────────────────────────────────────────────────────

export function buildExpleeBody(person: FindPerson, preset: ExpleePreset): Record<string, unknown> {
  return {
    first_name: (person.firstName ?? "").trim(),
    last_name: (person.lastName ?? "").trim(),
    company_domain: normalizeDomain(person.domain),
    preset,
  };
}

export async function findWithExplee(apiKey: string, person: FindPerson, preset: ExpleePreset): Promise<VendorFindResult> {
  const body = buildExpleeBody(person, preset);
  const { exchange, response, networkError } = await post(EXPLEE_FIND_URL, { "X-API-Key": apiKey }, body);

  if (networkError || !response) {
    // Explee has no idempotency key; a lost answer may still have been billed.
    throw new EmailFinderVendorError("explee", `explee email find failed: ${networkError?.message ?? "no response"}`, exchange, true);
  }
  if (response.status !== 200) {
    throw new EmailFinderVendorError("explee", vendorErrorMessage("explee", exchange), exchange);
  }

  const parsed = (exchange.responseBody ?? {}) as {
    email?: unknown;
    email_status?: unknown;
    meta?: { credits_charged?: unknown };
  };
  const email = str(parsed.email);
  const credits = parsed.meta?.credits_charged;
  if (typeof credits !== "number" || !Number.isFinite(credits) || credits < 0) {
    throw new EmailFinderVendorError(
      "explee",
      `explee answered without a readable meta.credits_charged (${JSON.stringify(credits)}) — cannot declare the cost`,
      exchange,
      !!email
    );
  }

  const vendorMailboxStatus = email ? str(parsed.email_status) : null;
  return rejectNonWorkEmail(
    {
      outcome: email ? "found" : "not_found",
      email,
      vendorMailboxStatus,
      mailboxStatus: normalizeMailboxStatus(vendorMailboxStatus),
      underlyingProvider: "explee",
      chargedQuantity: credits,
      rejectedEmail: null,
      rejectionReason: null,
      exchange,
    },
    person
  );
}
