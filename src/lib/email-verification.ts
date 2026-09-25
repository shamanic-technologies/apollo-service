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
 * Verifier: the BounceVerify Apify actor (real SMTP + catch-all detection),
 * ~3s per address, billed only on a DECISIVE result (`unknown` is free). Cost
 * name `apify-bounceverify-email`, platform (or org) `apify` key.
 *
 * Fail loud: a verification that cannot be declared, authorized or completed
 * throws EmailVerificationError. An unverified address is NEVER handed back as
 * deliverable.
 */

import { and, desc, eq, gt, isNotNull, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { emailVerifications, type EmailVerification } from "../db/schema.js";
import { decryptKey, type TrackingContext } from "./keys-client.js";
import { createRun, updateRun, addCosts, updateCostStatus, type IdentityHeaders } from "./runs-client.js";
import { authorizeCredit } from "./billing-client.js";

export const VERIFY_EMAIL_COST_NAME = "apify-bounceverify-email";
export const VERIFIER = "bounceverify";
const ACTOR = "bounceverify~bounceverify-email-verifier";
const ACTOR_TIMEOUT_S = 60;
const FETCH_TIMEOUT_MS = 90_000;

/**
 * A decisive verdict younger than this is reused instead of paying again. A
 * mailbox's existence changes slowly; a month keeps the reuse honest.
 */
export const VERDICT_REUSE_DAYS = 30;

export type EmailVerdict = "valid" | "invalid" | "catch_all" | "risky" | "unknown";

/** THE policy switch: the verdicts a consumer may send to. */
export const DELIVERABLE_VERDICTS: ReadonlySet<EmailVerdict> = new Set<EmailVerdict>(["valid"]);

export class EmailVerificationError extends Error {
  constructor(message: string) {
    super(`email verification failed: ${message}`);
    this.name = "EmailVerificationError";
  }
}

/** What every reveal response carries, additive, beside `person`. */
export interface EmailVerificationResult {
  email: string;
  verdict: EmailVerdict;
  deliverable: boolean;
  verifier: typeof VERIFIER;
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

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toResult(row: EmailVerification, reused: boolean): EmailVerificationResult {
  const verdict = row.verdict as EmailVerdict;
  return {
    email: row.email,
    verdict,
    deliverable: DELIVERABLE_VERDICTS.has(verdict),
    verifier: VERIFIER,
    verificationId: row.id,
    verifiedAt: row.verifiedAt instanceof Date ? row.verifiedAt.toISOString() : String(row.verifiedAt),
    reused,
  };
}

async function latestDecisiveVerdict(email: string): Promise<EmailVerification | undefined> {
  const since = new Date(Date.now() - VERDICT_REUSE_DAYS * 24 * 60 * 60 * 1000);
  const [row] = await db
    .select()
    .from(emailVerifications)
    .where(
      and(
        eq(emailVerifications.email, email),
        isNotNull(emailVerifications.verdict),
        ne(emailVerifications.verdict, "unknown"),
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

async function callActor(apifyToken: string, email: string): Promise<ActorCall> {
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?timeout=${ACTOR_TIMEOUT_S}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apifyToken}` },
      body: JSON.stringify({ emails: [email] }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return { rows: null, httpStatus: null, error: `apify unreachable: ${err instanceof Error ? err.message : String(err)}`, durationMs: Date.now() - started };
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

/**
 * Verdict for one revealed address: reused when a decisive one is held,
 * otherwise verified now under the full cost protocol (provision → authorize
 * → execute → actualize, hold cancelled). Throws EmailVerificationError on any
 * failure — never returns an unverified address as deliverable.
 */
export async function verifyRevealedEmail(rawEmail: string, ctx: VerificationContext): Promise<EmailVerificationResult> {
  const email = normalizeEmail(rawEmail);
  if (!email) throw new EmailVerificationError("empty email");

  const held = await latestDecisiveVerdict(email);
  if (held) return toResult(held, true);

  const { identity, tracking } = ctx;
  if (!identity.userId) throw new EmailVerificationError("x-user-id is required to bill the verification");

  let apifyToken: string;
  let keySource: "org" | "platform";
  try {
    const resolved = await decryptKey(identity.orgId, identity.userId, "apify", { callerMethod: "POST", callerPath: "/verify-email" }, tracking);
    if (!resolved.key) throw new Error("key-service returned an empty key");
    apifyToken = resolved.key;
    keySource = resolved.keySource;
  } catch (err) {
    throw new EmailVerificationError(`no usable "apify" key in key-service: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (keySource === "platform") {
    const auth = await authorizeCredit({
      items: [{ costName: VERIFY_EMAIL_COST_NAME, quantity: 1 }],
      description: "pre-serve email verification",
      orgId: identity.orgId,
      userId: identity.userId,
      runId: ctx.runId,
      ...tracking,
    });
    if (!auth.sufficient) {
      throw new EmailVerificationError(`insufficient balance (balance=${auth.balance_cents}¢, required=${auth.required_cents}¢)`);
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
    taskName: "verify-email",
    parentRunId: ctx.runId,
  });

  let holdId: string | null = null;
  try {
    const provisioned = await addCosts(
      run.id,
      [{ costName: VERIFY_EMAIL_COST_NAME, costSource: keySource, quantity: 1, status: "provisioned" }],
      identity
    );
    holdId = provisioned.costs?.[0]?.id ?? null;
    if (!holdId) throw new EmailVerificationError(`runs-service returned no cost id for the ${VERIFY_EMAIL_COST_NAME} hold`);

    const call = await callActor(apifyToken, email);
    const row = call.rows?.find((r) => typeof r.email === "string" && normalizeEmail(r.email) === email);
    const verdict = call.error ? null : mapVerdict(row);
    // BounceVerify charges only a DECISIVE result; `unknown` is free.
    const billed = verdict !== null && verdict !== "unknown";

    const [stored] = await db
      .insert(emailVerifications)
      .values({
        email,
        verifier: VERIFIER,
        verdict,
        rawResult: (row ?? (call.rows ? { rows: call.rows } : null)) as object | null,
        httpStatus: call.httpStatus,
        error: call.error,
        orgId: identity.orgId,
        userId: identity.userId,
        runId: ctx.runId,
        verifyRunId: run.id,
        source: ctx.source,
        keySource,
        billed,
        durationMs: call.durationMs,
      })
      .returning();

    if (call.error || verdict === null) throw new EmailVerificationError(call.error ?? "no verdict");

    if (billed) {
      await addCosts(run.id, [{ costName: VERIFY_EMAIL_COST_NAME, costSource: keySource, quantity: 1, status: "actual" }], identity);
    }
    await updateCostStatus(run.id, holdId, "cancelled", identity);
    holdId = null;
    await updateRun(run.id, "completed", identity);
    return toResult(stored, false);
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
    throw new EmailVerificationError(err instanceof Error ? err.message : String(err));
  }
}

/** Verify when there is an address to verify; null otherwise (no email = nothing to send to). */
export async function verificationFor(
  email: string | null | undefined,
  ctx: VerificationContext
): Promise<EmailVerificationResult | null> {
  if (!email || !email.trim()) return null;
  return verifyRevealedEmail(email, ctx);
}
