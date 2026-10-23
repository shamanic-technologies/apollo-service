/**
 * Pre-serve email verification — will this revealed address BOUNCE?
 *
 * Getting a correct address is this service's job, so every email it hands
 * back as a reveal (Apollo /enrich and /match, and treg/Explee findings) carries
 * a verifier verdict. Moved here from human-service (v0.46.x
 * src/lib/email-verification.ts), which measured it on 100 bounced + 100
 * delivered production addresses:
 *
 *   verdict     bounced  delivered
 *   invalid        24        3
 *   unknown        32       15
 *   catch_all      41       46
 *   valid           3       36
 *
 * Only `valid` is DELIVERABLE. The person always comes back (so the consumer
 * can suppress them — the reveal credit is already spent); the verdict says
 * whether to send.
 *
 * Two steps (owner, 2026-10-16):
 *   1. ONE verdict from the cheapest verifier that ANSWERS: ContactOut (treg,
 *      free) → BounceVerify (Apify actor, real SMTP + catch-all detection,
 *      billed only on a DECISIVE result, cost `apify-bounceverify-email`) →
 *      TryKitt (treg, $0.0015) → MillionVerifier (treg, $0.00178). The next
 *      one is asked only when a verifier FAILS to answer; any verdict ends step 1.
 *   2. A step-1 catch_all or unknown goes to BounceBan (treg, $0.004), whose
 *      verdict DECIDES. Live sample 2026-10-16: of 10 BounceVerify unknowns
 *      BounceBan called 8 deliverable; both agreed 100% on valid and invalid.
 *   treg spend is `treg-micro-usd` = treg's own X-Treg-Cost-Micro. Every call
 *   is a bronze row naming its vendor, with its raw answer and its charge.
 *
 * Fail loud: a verification that cannot be declared, authorized or completed
 * throws EmailVerificationError. An unverified address is NEVER handed back as
 * deliverable.
 */

import { errorMessage, messageOf } from "./db-error.js";
import { isKeptVerdict, recordOutcomeDetached } from "./outcome-declarations.js";
import { and, desc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { emailVerifications, type EmailVerification } from "../db/schema.js";
import { decryptKey, type TrackingContext } from "./keys-client.js";
import { createRun, updateRun, addCosts, updateCostStatus, type IdentityHeaders } from "./runs-client.js";
import { authorizeCredit, type AuthorizeCreditResult } from "./billing-client.js";
import { describeCreditRefusal } from "./credit-refusal.js";
import { apifyCreditsExhausted, type ProviderErrorDetail } from "./provider-error.js";
import { reportProviderCreditsExhausted } from "./credit-alert.js";
import { domainHasMx, MailDomainLookupError } from "./mail-domain.js";
import { TREG_COST_NAME } from "./email-finders.js";

export const VERIFY_EMAIL_COST_NAME = "apify-bounceverify-email";
export const VERIFIER = "bounceverify";
/** Who stored a row: a step-1 verifier (contactout, bounceverify, trykitt, millionverifier) or bounceban (step 2). */
export type Verifier = string;
export const SECOND_OPINION_VERIFIER = "bounceban";
/** A step-1 verdict among these cannot stand alone: BounceBan decides (owner: « I meant catchall or unknown »). */
export const SECOND_OPINION_VERDICTS: ReadonlySet<EmailVerdict> = new Set<EmailVerdict>(["catch_all", "unknown"]);
export { TREG_COST_NAME };

const TREG_CALL_BASE = "https://treg.to/call/";
/** After an Apify exhaustion answer, Apify is asked again only after this long. */
export const APIFY_OUT_RETRY_MS = 60 * 60 * 1000;

export const BOUNCEBAN_ENDPOINT = "bounceban.people.email.verify";
export const BOUNCEBAN_STATUS_ENDPOINT = "bounceban.people.email.verify.status";
/** $0.004 per submission (charged at submission, even while `verifying`); held and authorized before. */
export const BOUNCEBAN_MAX_COST_MICRO = 4_000;
/** BounceBan's single endpoint waits up to 15s itself. */
const BOUNCEBAN_CALL_TIMEOUT_MS = 45_000;
/** A `verifying` task is polled (free) this often, for at most BOUNCEBAN_POLL_BUDGET_MS. */
export const BOUNCEBAN_POLL_INTERVAL_MS = 10_000;
export const BOUNCEBAN_POLL_BUDGET_MS = 90_000;
const BOUNCEBAN_IN_PROGRESS: ReadonlySet<string> = new Set(["verifying", "queue"]);
const ACTOR = "bounceverify~bounceverify-email-verifier";
/** First attempt's actor budget. Prod 2026-10-11..14: a verdict takes p50 3.6s, p99 28s, max 59.8s. */
export const ACTOR_TIMEOUT_S = 60;
/**
 * Budget of the ONE second chance a TIMED-OUT run gets (VERIFY-TIMEOUT-1014).
 * Longer than the first on purpose: the same address timed out up to 3 times
 * in a row at 60s (2-min spacing) and then answered at 59.8s, so a plain
 * repeat of 60s would lose the slow-but-alive mailbox server.
 */
export const ACTOR_RETRY_TIMEOUT_S = 120;
/** The HTTP wait outlives the actor budget by this much (Apify answers the run-failed itself). */
const FETCH_GRACE_MS = 30_000;

/**
 * A decisive verdict younger than this is reused instead of paying again. A
 * mailbox's existence changes slowly; a month keeps the reuse honest.
 */
export const VERDICT_REUSE_DAYS = 30;

export type EmailVerdict = "valid" | "invalid" | "catch_all" | "risky" | "unknown";

/** THE policy switch: the verdicts a consumer may send to. */
export const DELIVERABLE_VERDICTS: ReadonlySet<EmailVerdict> = new Set<EmailVerdict>(["valid"]);

export class EmailVerificationError extends Error {
  /** Set when the verifier itself is out of credits (callers read it via providerErrorFields). */
  readonly providerError?: ProviderErrorDetail;
  /** Set when billing refused the verification spend (balance or a sales funnel max budget). */
  creditRefusal?: AuthorizeCreditResult;
  constructor(message: string, providerError?: ProviderErrorDetail) {
    super(`email verification failed: ${message}`);
    this.name = "EmailVerificationError";
    if (providerError) this.providerError = providerError;
  }
}

/**
 * BounceBan had not finished when its poll budget ran out. The task is paid and
 * still running: the next ask for the SAME address resumes it (free). Loud for a
 * real person's address like any failure; a caller that can live without the
 * verdict (the reveal domain gate's probe) reads this subclass as "no evidence".
 */
export class SecondOpinionPendingError extends EmailVerificationError {
  readonly taskId: string | null;
  constructor(message: string, taskId: string | null) {
    super(message);
    this.name = "SecondOpinionPendingError";
    this.taskId = taskId;
  }
}

/**
 * Apify out of usage, read from the rejected response. Measured in prod
 * 2026-09-29: 403 `{"error":{"type":"platform-feature-disabled","message":
 * "Monthly usage hard limit exceeded"}}` for 20 hours, 4,801 failed
 * verifications, nobody told. 402 is Apify's "not enough usage to run a paid
 * actor". Narrow on purpose: an outage (502) or a bad token is not exhaustion.
 */
export function looksLikeApifyCreditExhaustion(status: number | null, body: string): boolean {
  if (status === 402) return true;
  return /usage hard limit|not-enough-usage|usage limit exceeded/i.test(body);
}

/** What every reveal response carries, additive, beside `person`. */
export interface EmailVerificationResult {
  email: string;
  verdict: EmailVerdict;
  deliverable: boolean;
  /** Who decided: the step-1 verifier that answered (contactout, bounceverify, trykitt, millionverifier) or bounceban (step 2). */
  verifier: Verifier;
  verificationId: string;
  verifiedAt: string;
  /** true = a verdict already held was reused; nothing was called or billed. */
  reused: boolean;
}

export interface VerificationContext {
  identity: IdentityHeaders;
  tracking: TrackingContext;
  /** The caller's run; the verification run hangs under it. */
  runId?: string;
  source: string;
}

/** Same precedence human-service used: invalid is terminal, catch-all cannot confirm, a spam trap is never valid. */
export function mapVerdict(row: Record<string, unknown> | undefined): EmailVerdict {
  if (!row) return "unknown";
  const raw = typeof row.status === "string" ? row.status.trim().toLowerCase() : "";
  if (raw === "invalid") return "invalid";
  if (row.is_catch_all === true) return "catch_all";
  if (row.is_spamtrap === true) return "risky";
  if (raw === "valid") return "valid";
  if (raw === "risky") return "risky";
  return "unknown";
}

/**
 * The vendor said `invalid` because it found no mail domain (reason "Domain
 * does not exist" / "No MX records found for domain"), not because a mail
 * server refused the mailbox. That claim is checked against our own DNS before
 * it may stand (DNE-FALSE-INVALID-1015, see mail-domain.ts).
 */
export function vendorClaimsNoMailDomain(row: unknown): boolean {
  if (!row || typeof row !== "object") return false;
  const r = row as Record<string, unknown>;
  if (mapVerdict(r) !== "invalid") return false;
  return r.domain_exists === false || r.mx_found === false;
}

/**
 * The verdict we state for the vendor's row. Identical to mapVerdict, except a
 * "no mail domain" invalid on a domain that DOES publish MX records: the
 * vendor never reached a mail server, so nothing is known about the mailbox →
 * `unknown` (never `valid`: there is no evidence the mailbox exists). A domain
 * with no MX stays `invalid`. A DNS lookup that cannot answer throws.
 */
export async function decideVerdict(row: Record<string, unknown> | undefined, email: string): Promise<EmailVerdict> {
  const mapped = mapVerdict(row);
  if (!vendorClaimsNoMailDomain(row)) return mapped;
  return (await domainHasMx(email.split("@")[1] ?? "")) ? "unknown" : "invalid";
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toResult(row: EmailVerification, reused: boolean): EmailVerificationResult {
  const verdict = row.verdict as EmailVerdict;
  return {
    email: row.email,
    verdict,
    deliverable: DELIVERABLE_VERDICTS.has(verdict),
    verifier: row.verifier as Verifier,
    verificationId: row.id,
    verifiedAt: row.verifiedAt instanceof Date ? row.verifiedAt.toISOString() : String(row.verifiedAt),
    reused,
  };
}

/**
 * true = this row is a FIRST-PASS verdict that cannot stand alone: BounceVerify
 * (or any step-1 verifier) said catch_all or unknown, so
 * BounceBan decides. ~4,700 of 5,079 BounceVerify unknowns in 30 days were
 * blocks on BounceVerify's own probing IP, not dead mailboxes (2026-10-16).
 */
export function needsSecondOpinion(row: Pick<EmailVerification, "verifier" | "verdict">): boolean {
  return row.verifier !== SECOND_OPINION_VERIFIER && row.verdict !== null && SECOND_OPINION_VERDICTS.has(row.verdict as EmailVerdict);
}

/**
 * The latest verdict held for the address under VERDICT_REUSE_DAYS, any
 * verifier. A final one is reused as-is; a step-1 catch_all / unknown is
 * reused as step 1 (no step-1 vendor re-asked) and only BounceBan runs.
 */
async function latestHeldVerdict(email: string): Promise<EmailVerification | undefined> {
  const since = new Date(Date.now() - VERDICT_REUSE_DAYS * 24 * 60 * 60 * 1000);
  const [row] = await db
    .select()
    .from(emailVerifications)
    .where(and(eq(emailVerifications.email, email), isNotNull(emailVerifications.verdict), gt(emailVerifications.verifiedAt, since)))
    .orderBy(desc(emailVerifications.verifiedAt))
    .limit(1);
  return row;
}

/**
 * A BounceBan verification submitted earlier that had not finished when the
 * caller gave up: polled by its id (free) instead of submitted (and paid) again.
 * BounceBan keeps results 90 days; a day is plenty to resume.
 */
async function pendingBounceban(email: string): Promise<EmailVerification | undefined> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [row] = await db
    .select()
    .from(emailVerifications)
    .where(
      and(
        eq(emailVerifications.email, email),
        eq(emailVerifications.verifier, SECOND_OPINION_VERIFIER),
        isNull(emailVerifications.verdict),
        sql`${emailVerifications.rawResult}->>'id' IS NOT NULL`,
        sql`${emailVerifications.rawResult}->>'status' IN ('verifying', 'queue')`,
        gt(emailVerifications.verifiedAt, since)
      )
    )
    .orderBy(desc(emailVerifications.verifiedAt))
    .limit(1);
  return row;
}

interface ActorCall {
  rows: Array<Record<string, unknown>> | null;
  httpStatus: number | null;
  error: string | null;
  durationMs: number;
}

/** Apify's own gateway answering 502/503/504 (an HTML error page, the actor
 * never ran) is retried once after this pause before the call counts as failed. */
export const APIFY_GATEWAY_RETRY_DELAY_MS = 1_000;

/**
 * The actor RAN but did not finish inside its budget: Apify answers 400
 * `run-failed` "... status: TIMED-OUT" (prod 2026-10-14, ~2.7% of calls), or
 * 408 when the sync wait itself runs out. Not a verdict, never one.
 */
export function isActorTimeout(call: Pick<ActorCall, "httpStatus" | "error">): boolean {
  if (!call.error) return false;
  if (call.httpStatus === 408) return true;
  return call.httpStatus === 400 && /TIMED-OUT/.test(call.error);
}

/**
 * At most ONE retry per verification, whichever the cause, so the worst case
 * stays bounded: gateway 5xx → same budget after 1s; actor timeout → one run
 * with ACTOR_RETRY_TIMEOUT_S. A timeout that repeats returns the second error
 * as-is: no verdict, the caller fails loud, nothing billed.
 * Worst case ≈ 60s + 120s actor time (hard cap 90s + 150s of HTTP wait).
 */
async function callActor(apifyToken: string, email: string): Promise<ActorCall> {
  const first = await callActorOnce(apifyToken, email, ACTOR_TIMEOUT_S);
  if (isActorTimeout(first)) {
    console.warn(`[Apollo Service] verify_email.apify_timeout_retry status=${first.httpStatus} after=${first.durationMs}ms budget=${ACTOR_RETRY_TIMEOUT_S}s`);
    const second = await callActorOnce(apifyToken, email, ACTOR_RETRY_TIMEOUT_S);
    return { ...second, durationMs: first.durationMs + second.durationMs };
  }
  if (first.httpStatus === null || ![502, 503, 504].includes(first.httpStatus)) return first;
  console.warn(`[Apollo Service] verify_email.apify_gateway_retry status=${first.httpStatus}`);
  await new Promise((resolve) => setTimeout(resolve, APIFY_GATEWAY_RETRY_DELAY_MS));
  return callActorOnce(apifyToken, email, ACTOR_TIMEOUT_S);
}

async function callActorOnce(apifyToken: string, email: string, actorTimeoutS: number): Promise<ActorCall> {
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?timeout=${actorTimeoutS}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apifyToken}` },
      body: JSON.stringify({ emails: [email] }),
      signal: AbortSignal.timeout(actorTimeoutS * 1000 + FETCH_GRACE_MS),
    });
  } catch (err) {
    return { rows: null, httpStatus: null, error: `apify unreachable: ${errorMessage(err)}`, durationMs: Date.now() - started };
  }
  const text = await res.text();
  const durationMs = Date.now() - started;
  if (!res.ok) return { rows: null, httpStatus: res.status, error: `apify bounceverify responded ${res.status}: ${text.slice(0, 300)}`, durationMs };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { rows: null, httpStatus: res.status, error: `apify bounceverify returned non-JSON: ${text.slice(0, 200)}`, durationMs };
  }
  if (!Array.isArray(parsed)) return { rows: null, httpStatus: res.status, error: "apify bounceverify returned a non-array body", durationMs };
  return { rows: parsed as Array<Record<string, unknown>>, httpStatus: res.status, error: null, durationMs };
}

// ─── treg verifiers (step-1 fallbacks, BounceBan step 2) ─────────────────────

interface TregKeys {
  token: string;
  org: string;
}

interface TregAnswer {
  httpStatus: number | null;
  body: Record<string, unknown> | null;
  /** X-Treg-Cost-Micro; null when treg sent none. */
  chargedMicro: number | null;
  error: string | null;
}

async function tregCall(
  keys: TregKeys,
  endpoint: string,
  req: { query?: Record<string, string>; body?: Record<string, unknown>; headers?: Record<string, string> },
  timeoutMs: number
): Promise<TregAnswer> {
  let res: Response;
  try {
    const qs = req.query ? `?${new URLSearchParams(req.query).toString()}` : "";
    res = await fetch(`${TREG_CALL_BASE}${endpoint}${qs}`, {
      method: req.body ? "POST" : "GET",
      // Our bronze table is the cache: a verification asked here is a live one.
      headers: {
        "X-Treg-Token": keys.token,
        "X-Treg-Org": keys.org,
        "Cache-Control": "no-cache",
        ...(req.body ? { "Content-Type": "application/json" } : {}),
        ...req.headers,
      },
      body: req.body ? JSON.stringify(req.body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { httpStatus: null, body: null, chargedMicro: null, error: `treg ${endpoint} unreachable: ${errorMessage(err)}` };
  }
  const text = await res.text();
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = text ? JSON.parse(text) : null;
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { _raw: text.slice(0, 2000) };
  } catch {
    body = { _raw: text.slice(0, 2000) };
  }
  const header = res.headers.get("x-treg-cost-micro");
  const charged = header === null || header.trim() === "" ? null : Number(header);
  const chargedMicro = charged !== null && Number.isFinite(charged) && charged >= 0 ? charged : null;
  if (!res.ok) {
    // treg relays a provider's 4xx/5xx unchanged and charges nothing for it.
    return { httpStatus: res.status, body, chargedMicro: chargedMicro ?? 0, error: `treg ${endpoint} responded ${res.status}: ${text.slice(0, 300)}` };
  }
  if (chargedMicro === null) {
    return { httpStatus: res.status, body, chargedMicro: null, error: `treg ${endpoint} answered ${res.status} without X-Treg-Cost-Micro: the charge cannot be declared` };
  }
  return { httpStatus: res.status, body, chargedMicro, error: null };
}

/**
 * A step-1 verifier's own word → our verdict (ContactOut `data.status`:
 * `accept_all`; TryKitt `validity`; MillionVerifier `result`: `ok` /
 * `catch_all`). Anything else is not a verdict.
 */
export function mapVerifierWord(status: unknown): EmailVerdict | null {
  switch (typeof status === "string" ? status.trim().toLowerCase() : "") {
    case "valid":
    case "ok":
    case "deliverable":
      return "valid";
    case "invalid":
    case "undeliverable":
      return "invalid";
    case "accept_all":
    case "catch_all":
    case "catchall":
      return "catch_all";
    case "risky":
    case "disposable":
      return "risky";
    case "unknown":
    case "unverified":
      return "unknown";
    default:
      return null;
  }
}

/** BounceBan's `result` word → our verdict. `deliverable` on an accept-all domain is BounceBan's whole point: valid. */
export function mapBounceBanResult(body: Record<string, unknown> | null): EmailVerdict | null {
  const result = typeof body?.result === "string" ? body.result.trim().toLowerCase() : "";
  switch (result) {
    case "deliverable":
      return "valid";
    case "undeliverable":
      return "invalid";
    case "risky":
      return body?.is_accept_all === true ? "catch_all" : "risky";
    case "unknown":
      return "unknown";
    default:
      return null;
  }
}

function isBounceBanInProgress(body: Record<string, unknown> | null): boolean {
  return typeof body?.status === "string" && BOUNCEBAN_IN_PROGRESS.has(body.status);
}

// ─── One metered vendor call ─────────────────────────────────────────────────

/** What one vendor call left behind, before it is stored. */
interface VendorOutcome {
  verdict: EmailVerdict | null;
  rawResult: object | null;
  httpStatus: number | null;
  error: string | null;
  /** In the cost's unit; 0 = nothing billed. Declared as `actual` before anything else. */
  charged: number;
  durationMs: number;
}

interface VendorPlan {
  verifier: Verifier;
  taskName: string;
  costName: string;
  /** Worst case, held (and authorized on a platform key) before the call. */
  holdQuantity: number;
  /** key-service providers; the first one's keySource decides who pays. */
  keyProviders: readonly string[];
  description: string;
}

/**
 * key → authorize (platform key) → run → PROVISION hold → EXECUTE → bronze row
 * → ACTUALIZE what the vendor charged → hold cancelled → run closed. A VENDOR
 * failure comes back as a stored row with `error` (the caller decides between
 * a fallback and a loud failure); a failure of OUR side (key, billing, runs)
 * throws EmailVerificationError.
 */
async function meteredVerification(
  email: string,
  ctx: VerificationContext,
  plan: VendorPlan,
  execute: (keys: string[]) => Promise<VendorOutcome>
): Promise<EmailVerification> {
  const { identity, tracking } = ctx;
  if (!identity.userId) throw new EmailVerificationError("x-user-id is required to bill the verification");

  const keys: string[] = [];
  let keySource: "org" | "platform" | undefined;
  for (const provider of plan.keyProviders) {
    try {
      const resolved = await decryptKey(identity.orgId, identity.userId, provider, { callerMethod: "POST", callerPath: "/verify-email" }, tracking);
      if (!resolved.key) throw new Error("key-service returned an empty key");
      keys.push(resolved.key);
      keySource ??= resolved.keySource;
    } catch (err) {
      throw new EmailVerificationError(`no usable "${provider}" key in key-service: ${errorMessage(err)}`);
    }
  }
  const source = keySource!;

  // A zero hold (resuming a BounceBan task already paid for: polling is free) needs neither.
  if (source === "platform" && plan.holdQuantity > 0) {
    const auth = await authorizeCredit({
      items: [{ costName: plan.costName, quantity: plan.holdQuantity }],
      description: plan.description,
      orgId: identity.orgId,
      userId: identity.userId,
      runId: ctx.runId,
      ...tracking,
    });
    if (!auth.sufficient) {
      const refusal = new EmailVerificationError(describeCreditRefusal(auth));
      refusal.creditRefusal = auth;
      throw refusal;
    }
  }

  const run = await createRun({
    orgId: identity.orgId,
    userId: identity.userId,
    brandIds: tracking.brandIds,
    campaignId: tracking.campaignId,
    audienceId: tracking.audienceId,
    featureSlug: tracking.featureSlug,
    workflowSlug: tracking.workflowSlug,
    serviceName: "apollo-service",
    taskName: plan.taskName,
    parentRunId: ctx.runId,
  });

  let holdId: string | null = null;
  try {
    if (plan.holdQuantity > 0) {
      const provisioned = await addCosts(run.id, [{ costName: plan.costName, costSource: source, quantity: plan.holdQuantity, status: "provisioned" }], identity);
      holdId = provisioned.costs?.[0]?.id ?? null;
      if (!holdId) throw new EmailVerificationError(`runs-service returned no cost id for the ${plan.costName} hold`);
    }

    const outcome = await execute(keys);

    const [stored] = await db
      .insert(emailVerifications)
      .values({
        email,
        verifier: plan.verifier,
        verdict: outcome.verdict,
        rawResult: outcome.rawResult,
        httpStatus: outcome.httpStatus,
        error: outcome.error,
        orgId: identity.orgId,
        userId: identity.userId,
        runId: ctx.runId,
        verifyRunId: run.id,
        source: ctx.source,
        keySource: source,
        billed: outcome.charged > 0,
        costName: plan.costName,
        costQuantity: outcome.charged,
        durationMs: outcome.durationMs,
      })
      .returning();

    if (outcome.charged > 0) {
      await addCosts(run.id, [{ costName: plan.costName, costSource: source, quantity: outcome.charged, status: "actual" }], identity);
    }
    if (holdId) await updateCostStatus(run.id, holdId, "cancelled", identity);
    holdId = null;
    await updateRun(run.id, outcome.error || outcome.verdict === null ? "failed" : "completed", identity);
    // A KEPT FINAL verdict is this run's output: it checked the email the
    // person's lead was found with. An invalid one is a loss, and a step-1
    // catch_all/unknown is not final (BounceBan decides it): nothing declared,
    // its cost rides the kept units.
    if (!outcome.error && isFinalKeptVerdict(plan.verifier, stored.verdict)) {
      recordOutcomeDetached({
        runId: run.id,
        orgId: identity.orgId,
        brandIds: tracking.brandIds,
        campaignId: tracking.campaignId,
        produced: ["email_checked"],
        consumed: ["email_found"],
        person: { email },
      });
    }
    return stored;
  } catch (err) {
    // Release the hold (nothing was bought) and fail the run, then surface the
    // ORIGINAL error. A cleanup failure is logged, never swallowed in its place.
    if (holdId) {
      await updateCostStatus(run.id, holdId, "cancelled", identity).catch((e) =>
        console.error(`[Apollo Service] verify_email.cancel_hold_failed run=${run.id}`, e)
      );
    }
    await updateRun(run.id, "failed", identity).catch((e) => console.error(`[Apollo Service] verify_email.mark_failed_failed run=${run.id}`, e));
    if (err instanceof EmailVerificationError) throw err;
    throw new EmailVerificationError(errorMessage(err));
  }
}

/** valid at step 1, or whatever BounceBan (step 2) decides when it is valid / catch_all / unknown. */
export function isFinalKeptVerdict(verifier: string, verdict: string | null): boolean {
  if (!isKeptVerdict(verdict)) return false;
  return verifier === SECOND_OPINION_VERIFIER || verdict === "valid";
}

function failLoud(row: EmailVerification, providerError?: ProviderErrorDetail): never {
  throw new EmailVerificationError(`${row.verifier}: ${row.error ?? "no verdict"}`, providerError);
}

// ─── Step 1: the cheapest verifier that ANSWERS ──────────────────────────────

/** A step-1 verifier reached through treg (its catalog endpoint, called directly). */
interface TregStep {
  verifier: string;
  endpoint: string;
  /** Held (and authorized on a platform key) before the call, in treg micro-USD. */
  holdMicro: number;
  request: (email: string) => { query?: Record<string, string>; body?: Record<string, unknown> };
  /** The vendor's own word → verdict, or a vendor-reported error. */
  read: (body: Record<string, unknown> | null) => { verdict: EmailVerdict | null; word: unknown; vendorError?: string | null };
  timeoutMs: number;
}

/** Free under ContactOut's current terms (catalog 2026-10-17); answers `{data: {status}}`, often 429s. */
export const CONTACTOUT_STEP: TregStep = {
  verifier: "contactout",
  endpoint: "contactout.people.email.verify",
  holdMicro: 0,
  request: (email) => ({ query: { email } }),
  read: (body) => {
    const word = (body?.data as { status?: unknown } | undefined)?.status;
    return { verdict: mapVerifierWord(word), word };
  },
  timeoutMs: 30_000,
};

/** $0.0015 per completed verification, every result; `realtime: true` is required on treg (live 2026-10-17). */
export const TRYKITT_STEP: TregStep = {
  verifier: "trykitt",
  endpoint: "trykitt.people.email.verify",
  holdMicro: 2_000,
  request: (email) => ({ body: { email, realtime: true } }),
  read: (body) => ({ verdict: mapVerifierWord(body?.validity), word: body?.validity }),
  timeoutMs: 60_000,
};

/** $0.00178 per success; answers `{result, error}` (live 2026-10-16). */
export const MILLIONVERIFIER_STEP: TregStep = {
  verifier: "millionverifier",
  endpoint: "millionverifier.people.email.verify",
  holdMicro: 2_000,
  request: (email) => ({ query: { email, timeout: "20" } }),
  read: (body) => ({
    verdict: mapVerifierWord(body?.result),
    word: body?.result,
    vendorError: typeof body?.error === "string" && body.error.trim() ? body.error : null,
  }),
  timeoutMs: 45_000,
};

async function bounceVerifyPass(email: string, ctx: VerificationContext): Promise<EmailVerification> {
  return meteredVerification(
    email,
    ctx,
    { verifier: "bounceverify", taskName: "verify-email", costName: VERIFY_EMAIL_COST_NAME, holdQuantity: 1, keyProviders: ["apify"], description: "pre-serve email verification" },
    async ([apifyToken]) => {
      const call = await callActor(apifyToken, email);
      const row = call.rows?.find((r) => typeof r.email === "string" && normalizeEmail(r.email) === email);
      // BounceVerify charges only a DECISIVE result of ITS OWN; `unknown` is free.
      const billed = !call.error && mapVerdict(row) !== "unknown";
      let verdict: EmailVerdict | null = null;
      let lookupError: string | null = null;
      if (!call.error) {
        try {
          verdict = await decideVerdict(row, email);
        } catch (err) {
          if (!(err instanceof MailDomainLookupError)) throw err;
          // The vendor answered (and charged); only our DNS check could not:
          // no verdict is better than a false one, the charge is still declared.
          lookupError = messageOf(err);
        }
      }
      return {
        verdict,
        rawResult: (row ?? (call.rows ? { rows: call.rows } : null)) as object | null,
        httpStatus: call.httpStatus,
        error: call.error ?? lookupError,
        charged: billed ? 1 : 0,
        durationMs: call.durationMs,
      };
    }
  );
}

async function tregVerifierPass(email: string, ctx: VerificationContext, step: TregStep): Promise<EmailVerification> {
  return meteredVerification(
    email,
    ctx,
    {
      verifier: step.verifier,
      taskName: `verify-email-${step.verifier}`,
      costName: TREG_COST_NAME,
      holdQuantity: step.holdMicro,
      keyProviders: ["treg", "treg-org"],
      description: `pre-serve email verification (${step.verifier})`,
    },
    async ([token, org]) => {
      const started = Date.now();
      const answer = await tregCall({ token, org }, step.endpoint, step.request(email), step.timeoutMs);
      let error = answer.error;
      let verdict: EmailVerdict | null = null;
      if (!error) {
        const read = step.read(answer.body);
        if (read.vendorError) error = `${step.verifier}: ${read.vendorError}`;
        else if (read.verdict === null) error = `${step.verifier} returned no known verdict (${JSON.stringify(read.word)})`;
        else verdict = read.verdict;
      }
      return { verdict, rawResult: answer.body, httpStatus: answer.httpStatus, error, charged: answer.chargedMicro ?? 0, durationMs: Date.now() - started };
    }
  );
}

async function bounceBanPass(email: string, ctx: VerificationContext, resumeId: string | null): Promise<EmailVerification> {
  return meteredVerification(
    email,
    ctx,
    {
      verifier: SECOND_OPINION_VERIFIER,
      taskName: "verify-email-bounceban",
      costName: TREG_COST_NAME,
      // Resuming an earlier submission only polls (free); a submission is paid.
      holdQuantity: resumeId ? 0 : BOUNCEBAN_MAX_COST_MICRO,
      keyProviders: ["treg", "treg-org"],
      description: "pre-serve email verification (BounceBan second opinion)",
    },
    async ([token, org]) => {
      const keys = { token, org };
      const started = Date.now();
      let charged = 0;
      let answer: TregAnswer;
      if (resumeId) {
        answer = await tregCall(keys, BOUNCEBAN_STATUS_ENDPOINT, { query: { id: resumeId } }, BOUNCEBAN_CALL_TIMEOUT_MS);
      } else {
        answer = await tregCall(keys, BOUNCEBAN_ENDPOINT, { query: { email, mode: "regular" } }, BOUNCEBAN_CALL_TIMEOUT_MS);
      }
      charged += answer.chargedMicro ?? 0;
      // BounceBan answers `verifying` / `queue` when it needs longer than its
      // 15s wait (the charge is already final, treg says so); poll the status
      // endpoint (free) by the task id.
      const taskId = typeof answer.body?.id === "string" ? answer.body.id : resumeId;
      while (!answer.error && isBounceBanInProgress(answer.body) && taskId && Date.now() - started < BOUNCEBAN_POLL_BUDGET_MS) {
        await new Promise((resolve) => setTimeout(resolve, BOUNCEBAN_POLL_INTERVAL_MS));
        const polled = await tregCall(keys, BOUNCEBAN_STATUS_ENDPOINT, { query: { id: taskId } }, BOUNCEBAN_CALL_TIMEOUT_MS);
        charged += polled.chargedMicro ?? 0;
        // A failed poll keeps the submission's body (and its id) so a later ask resumes it.
        if (polled.error) {
          answer = { ...polled, body: answer.body };
          break;
        }
        answer = polled;
      }
      let error = answer.error;
      let verdict: EmailVerdict | null = null;
      if (!error) {
        if (isBounceBanInProgress(answer.body)) {
          error = `bounceban still ${String(answer.body?.status)} after ${Math.round((Date.now() - started) / 1000)}s (task ${taskId}); the next ask resumes it`;
        } else if (answer.body?.status !== "success") {
          error = `bounceban task ended with status ${JSON.stringify(answer.body?.status)}`;
        } else {
          verdict = mapBounceBanResult(answer.body);
          if (verdict === null) error = `bounceban returned no known result (${JSON.stringify(answer.body?.result)})`;
        }
      }
      return { verdict, rawResult: answer.body, httpStatus: answer.httpStatus, error, charged, durationMs: Date.now() - started };
    }
  );
}

// ─── Apify out of usage → skipped for a while ────────────────────────────────

let apifyOutUntil = 0;

/** Tests only. */
export function resetApifyFallback(): void {
  apifyOutUntil = 0;
}

export function apifyOut(now: number = Date.now()): boolean {
  return now < apifyOutUntil;
}

/** Step 1, in price order. Each one is tried only when the previous one FAILED to answer. */
export const STEP_ONE_ORDER = ["contactout", "bounceverify", "trykitt", "millionverifier"] as const;

/**
 * STEP 1 — ONE verdict, from the cheapest verifier that ANSWERS (owner,
 * 2026-10-16: « Les 4 ne sont que des fallback de la même étape 1. Dès qu'on a
 * un résultat, soit on garde, soit on passe à l'étape 2 (BounceBan) »):
 * ContactOut (free) → BounceVerify ($0.00089) → TryKitt ($0.0015) →
 * MillionVerifier ($0.00178). The next one is asked ONLY when a verifier fails
 * to answer (429, out of credit, timeout, error); any verdict, `unknown`
 * included, ends step 1. Every attempt is a bronze row with its own spend.
 * After an Apify exhaustion answer, BounceVerify is skipped for
 * APIFY_OUT_RETRY_MS (staff emailed once), then asked again. Every verifier
 * failing → loud, never a verdict.
 */
async function stepOne(email: string, ctx: VerificationContext): Promise<EmailVerification> {
  const failures: string[] = [];
  for (const verifier of STEP_ONE_ORDER) {
    let row: EmailVerification;
    if (verifier === "bounceverify") {
      if (apifyOut()) {
        failures.push("bounceverify: skipped, Apify out of usage");
        continue;
      }
      row = await bounceVerifyPass(email, ctx);
      if (row.error && looksLikeApifyCreditExhaustion(row.httpStatus, row.error)) {
        reportProviderCreditsExhausted("apify", { ...ctx.identity, runId: ctx.runId }, {
          operation: "bounceverify",
          reason: "Apify refused the email-verification actor: the account's usage limit is reached (TryKitt / MillionVerifier verify instead)",
          upstreamStatus: row.httpStatus ?? undefined,
          upstreamBody: row.error,
        });
        apifyOutUntil = Date.now() + APIFY_OUT_RETRY_MS;
        console.warn(`[Apollo Service] verify_email.apify_out skipped for ${APIFY_OUT_RETRY_MS / 60000}min`);
      }
    } else {
      row = await tregVerifierPass(email, ctx, verifier === "contactout" ? CONTACTOUT_STEP : verifier === "trykitt" ? TRYKITT_STEP : MILLIONVERIFIER_STEP);
    }
    if (!row.error && row.verdict !== null) return row;
    failures.push(`${row.verifier}: ${row.error ?? "no verdict"}`);
    console.warn(`[Apollo Service] verify_email.step1_failed verifier=${row.verifier} next=${STEP_ONE_ORDER[STEP_ONE_ORDER.indexOf(verifier) + 1] ?? "none"} error=${(row.error ?? "").slice(0, 200)}`);
  }
  throw new EmailVerificationError(`every step-1 verifier failed — ${failures.join("; ")}`, apifyOut() ? apifyCreditsExhausted() : undefined);
}

/** STEP 2 — BounceBan decides a step-1 catch_all / unknown. A failure is loud: the step-1 verdict alone is never served. */
async function secondOpinion(email: string, ctx: VerificationContext): Promise<EmailVerificationResult> {
  // An earlier BounceBan task still running for this address is resumed (polled, free), not paid again.
  const pending = await pendingBounceban(email);
  const row = await bounceBanPass(email, ctx, pending ? String((pending.rawResult as { id: string }).id) : null);
  if (row.error && isBounceBanInProgress(row.rawResult as Record<string, unknown> | null)) {
    const id = (row.rawResult as { id?: unknown } | null)?.id;
    throw new SecondOpinionPendingError(`${row.verifier}: ${row.error}`, typeof id === "string" ? id : null);
  }
  if (row.error || row.verdict === null) failLoud(row);
  return toResult(row, false);
}

/**
 * Verdict for one revealed address. A held FINAL verdict is reused; otherwise
 * step 1 runs (the cheapest verifier that answers) and
 * a step-1 catch_all / unknown goes to BounceBan, whose verdict decides.
 * Every vendor call runs the full cost protocol (provision → authorize →
 * execute → actualize, hold cancelled). Throws EmailVerificationError on any
 * failure — never returns an unverified address as deliverable.
 */
export async function verifyRevealedEmail(rawEmail: string, ctx: VerificationContext): Promise<EmailVerificationResult> {
  const email = normalizeEmail(rawEmail);
  if (!email) throw new EmailVerificationError("empty email");

  let first = await latestHeldVerdict(email);
  if (first) {
    // A row stored before decideVerdict existed (or while the domain had no
    // MX) carries the vendor's "no mail domain" invalid: re-check it now, free,
    // so an old false invalid never blocks a send.
    if (first.verifier === "bounceverify" && first.verdict === "invalid" && vendorClaimsNoMailDomain(first.rawResult)) {
      first = await recheckHeldInvalid(first, email, ctx);
    }
    if (!needsSecondOpinion(first)) return toResult(first, true);
  } else {
    first = await stepOne(email, ctx);
    if (!needsSecondOpinion(first)) return toResult(first, false);
  }
  return secondOpinion(email, ctx);
}

/**
 * A held "no mail domain" invalid, re-judged against today's DNS. MX found →
 * a NEW bronze row with verdict `unknown` (same vendor row, nothing called,
 * nothing billed), which then goes to the second opinion. No MX → the held
 * invalid stands.
 */
async function recheckHeldInvalid(held: EmailVerification, email: string, ctx: VerificationContext): Promise<EmailVerification> {
  let hasMx: boolean;
  try {
    hasMx = await domainHasMx(email.split("@")[1] ?? "");
  } catch (err) {
    throw new EmailVerificationError(errorMessage(err));
  }
  if (!hasMx) return held;
  const [corrected] = await db
    .insert(emailVerifications)
    .values({
      email,
      verifier: VERIFIER,
      verdict: "unknown",
      rawResult: held.rawResult as object | null,
      httpStatus: held.httpStatus,
      error: null,
      orgId: ctx.identity.orgId,
      userId: ctx.identity.userId,
      runId: ctx.runId,
      verifyRunId: null,
      source: ctx.source,
      keySource: null,
      billed: false,
      durationMs: 0,
    })
    .returning();
  console.warn(`[Apollo Service] verify_email.dne_overruled email=${email} held=${held.id} corrected=${corrected.id}`);
  return corrected;
}

/** Most addresses one batch call may carry. A slice of a paced release is far smaller. */
export const MAX_VERIFY_BATCH = 50;

/**
 * How many addresses of one batch are verified at once. BounceVerify takes ~3s
 * an address, so a full batch answers in ~15s typically; the worst case is
 * bounded by ceil(MAX_VERIFY_BATCH / this) actor timeouts.
 */
export const VERIFY_BATCH_CONCURRENCY = 10;

/**
 * Verdicts for addresses a caller already HOLDS (not a reveal): each one goes
 * through verifyRevealedEmail, so the bronze row, the 30-day reuse and the
 * cost protocol are exactly the reveal path's. Duplicates (after lower-casing)
 * are verified once. Returned in first-seen input order.
 *
 * All or nothing: if ANY address cannot be verified this throws
 * EmailVerificationError naming the failures, and the caller gets no verdict
 * at all — a partial answer invites sending to the half it covers while the
 * other half is silently dropped. What did succeed is already stored, so a
 * retry reuses every decisive verdict for free and re-runs only the rest.
 */
export async function verifyEmailBatch(rawEmails: string[], ctx: VerificationContext): Promise<EmailVerificationResult[]> {
  const emails: string[] = [];
  for (const raw of rawEmails) {
    const email = normalizeEmail(raw);
    if (!email) throw new EmailVerificationError("empty email in batch");
    if (!emails.includes(email)) emails.push(email);
  }
  if (emails.length > MAX_VERIFY_BATCH) {
    throw new EmailVerificationError(`batch of ${emails.length} exceeds ${MAX_VERIFY_BATCH}`);
  }

  const results = new Array<EmailVerificationResult | undefined>(emails.length);
  const failures: string[] = [];
  let providerError: ProviderErrorDetail | undefined;
  let creditRefusal: AuthorizeCreditResult | undefined;
  let next = 0;
  const worker = async () => {
    while (next < emails.length) {
      const i = next++;
      try {
        results[i] = await verifyRevealedEmail(emails[i], ctx);
      } catch (err) {
        failures.push(`${emails[i]}: ${errorMessage(err)}`);
        if (err instanceof EmailVerificationError && err.providerError) providerError = err.providerError;
        if (err instanceof EmailVerificationError && err.creditRefusal) creditRefusal = err.creditRefusal;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(VERIFY_BATCH_CONCURRENCY, emails.length) }, worker));

  if (failures.length > 0) {
    const failed = new EmailVerificationError(`${failures.length} of ${emails.length} address(es) could not be verified — ${failures.slice(0, 5).join("; ")}`, providerError);
    if (creditRefusal) failed.creditRefusal = creditRefusal;
    throw failed;
  }
  return results as EmailVerificationResult[];
}

/** Verify when there is an address to verify; null otherwise (no email = nothing to send to). */
export async function verificationFor(
  email: string | null | undefined,
  ctx: VerificationContext
): Promise<EmailVerificationResult | null> {
  if (!email || !email.trim()) return null;
  return verifyRevealedEmail(email, ctx);
}
