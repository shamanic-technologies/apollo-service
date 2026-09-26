/**
 * The email-find protocol (treg / Explee), shared by POST /email-finder/find
 * and the QuickEnrich branch of POST /enrich. Lives outside the route module
 * so /enrich reuses it without importing a router.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { emailFinderCalls, emailFindings, type EmailFinding } from "../db/schema.js";
import { decryptKey } from "./keys-client.js";
import { createRun, updateRun, addCosts, updateCostStatus, type IdentityHeaders } from "./runs-client.js";
import { authorizeCredit } from "./billing-client.js";
import { assertKeySource } from "./validators.js";
import { traceEvent } from "./trace-event.js";
import { verificationFor, EmailVerificationError } from "./email-verification.js";
import {
  EXPLEE_COST_NAME,
  EXPLEE_PRESET_CREDITS,
  EmailFinderVendorError,
  TREG_COST_NAME,
  TREG_MAX_COST_MICRO,
  TREG_PRESET,
  findWithExplee,
  findWithTreg,
  normalizeDomain,
  personKeyOf,
  type EmailFinderVendor,
  type ExpleePreset,
  type FindPerson,
  type VendorExchange,
  type VendorFindResult,
} from "./email-finders.js";

export type Vendor = EmailFinderVendor;

interface VendorPlan {
  costName: string;
  /** Worst case, in the catalogue unit: provisioned + authorized before the call. */
  maxQuantity: number;
  chargedUnit: string;
  keyProvider: string;
}

function planFor(vendor: Vendor, preset: string): VendorPlan {
  if (vendor === "treg") {
    return { costName: TREG_COST_NAME, maxQuantity: TREG_MAX_COST_MICRO, chargedUnit: "micro-USD", keyProvider: "treg" };
  }
  return { costName: EXPLEE_COST_NAME, maxQuantity: EXPLEE_PRESET_CREDITS[preset as ExpleePreset], chargedUnit: "credit", keyProvider: "explee" };
}

/** The wire shape every route answers with — the silver row, named for a consumer. */
export function toFindingResponse(row: EmailFinding) {
  const iso = (d: Date | string | null | undefined) => (d ? (d instanceof Date ? d.toISOString() : d) : null);
  return {
    findingId: row.id,
    vendor: row.vendor,
    preset: row.preset,
    personKey: row.personKey,
    apolloPersonId: row.apolloPersonId ?? null,
    status: row.status,
    found: row.status === "found",
    email: row.email ?? null,
    vendorMailboxStatus: row.vendorMailboxStatus ?? null,
    mailboxStatus: row.mailboxStatus ?? null,
    underlyingProvider: row.underlyingProvider ?? null,
    costName: row.costName,
    chargedQuantity: row.chargedQuantity === null || row.chargedQuantity === undefined ? null : Number(row.chargedQuantity),
    chargedUnit: row.chargedUnit ?? null,
    failureReason: row.failureReason ?? null,
    rejectedEmail: row.rejectedEmail ?? null,
    rejectionReason: row.rejectionReason ?? null,
    requestedAt: iso(row.requestedAt),
    completedAt: iso(row.completedAt),
  };
}

async function findExisting(vendor: string, preset: string, personKey: string): Promise<EmailFinding | undefined> {
  const [row] = await db
    .select()
    .from(emailFindings)
    .where(and(eq(emailFindings.vendor, vendor), eq(emailFindings.preset, preset), eq(emailFindings.personKey, personKey)))
    .limit(1);
  return row;
}

function statusCodeFor(row: EmailFinding): number {
  return row.status === "pending" ? 202 : 200;
}

/** A row that already answers the question: re-serving it costs nothing and calls nobody. */
function isSettledOrInFlight(row: EmailFinding): boolean {
  return row.status === "found" || row.status === "not_found" || row.status === "pending";
}

async function writeBronze(args: {
  findingId: string;
  vendor: Vendor;
  preset: string;
  orgId: string;
  userId?: string;
  runId?: string;
  findRunId?: string;
  exchange: VendorExchange;
  underlyingProvider: string | null;
  chargedQuantity: number | null;
  chargedUnit: string;
  error: string | null;
}): Promise<string> {
  const [row] = await db
    .insert(emailFinderCalls)
    .values({
      findingId: args.findingId,
      vendor: args.vendor,
      preset: args.preset,
      orgId: args.orgId,
      userId: args.userId,
      runId: args.runId,
      findRunId: args.findRunId,
      requestUrl: args.exchange.requestUrl,
      requestHeaders: args.exchange.requestHeaders,
      requestBody: args.exchange.requestBody,
      httpStatus: args.exchange.httpStatus,
      responseHeaders: args.exchange.responseHeaders,
      responseBody: args.exchange.responseBody as object | null,
      underlyingProvider: args.underlyingProvider,
      chargedQuantity: args.chargedQuantity === null ? null : String(args.chargedQuantity),
      chargedUnit: args.chargedUnit,
      error: args.error,
      durationMs: args.exchange.durationMs,
    })
    .returning({ id: emailFinderCalls.id });
  return row.id;
}

/** A platform key the owner has not put in key-service yet: say so, plainly. */
class ProviderKeyMissingError extends Error {}

async function resolveKey(orgId: string, userId: string, provider: string, tracking: Record<string, unknown>, callerPath: string) {
  try {
    const resolved = await decryptKey(orgId, userId, provider, { callerMethod: "POST", callerPath }, tracking);
    assertKeySource(resolved.keySource);
    if (!resolved.key) throw new Error("key-service returned an empty key");
    return resolved;
  } catch (err) {
    throw new ProviderKeyMissingError(
      `No usable "${provider}" key in key-service (platform provider "${provider}"): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export interface EmailFindContext {
  orgId: string;
  userId?: string;
  runId: string;
  brandIds?: string[];
  campaignId?: string;
  audienceId?: string;
  featureSlug?: string;
  workflowSlug?: string;
  /** Inbound headers, forwarded on trace events. */
  headers: Record<string, string | string[] | undefined>;
  /** Our route asking, for key-service's caller record. */
  callerPath: string;
}

export interface EmailFindOutcome {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Ask treg or Explee for a person's work email — the whole find protocol
 * (silver reuse, key, authorize, claim, provision, execute, bronze, actualize,
 * verdict), shared by POST /email-finder/find and the QuickEnrich branch of
 * POST /enrich. Returns the HTTP status + body the route answers with.
 *
 * Idempotent on (vendor, preset, person): a finding that is found, not found,
 * or still in flight is served from the silver row and the vendor is never
 * called again, so a re-run never pays twice. Only a `failed` finding (the
 * vendor answered with an error, which it does not bill) is retried.
 */
export async function executeEmailFind(
  ctx: EmailFindContext,
  vendor: Vendor,
  presetIn: ExpleePreset | undefined,
  person: FindPerson
): Promise<EmailFindOutcome> {
  const { orgId, userId, runId, brandIds, campaignId, audienceId, featureSlug, workflowSlug, headers } = ctx;
  const preset = vendor === "treg" ? TREG_PRESET : (presetIn as ExpleePreset);
  const personKey = personKeyOf(person);
  const plan = planFor(vendor, preset);
  const identity: IdentityHeaders = { orgId: orgId, userId: userId, brandIds, campaignId, audienceId, featureSlug, workflowSlug };
  const tracking = { brandIds, campaignId, audienceId, featureSlug, workflowSlug };
  // A found address carries the verifier's verdict, like every Apollo reveal.
  const verifyCtx = { identity, tracking, runId, source: `email-finder:${vendor}` };
  const respond = async (row: EmailFinding, reused: boolean): Promise<EmailFindOutcome> => ({
    status: statusCodeFor(row),
    body: {
      ...toFindingResponse(row),
      reused,
      emailVerification: row.status === "found" ? await verificationFor(row.email, verifyCtx) : null,
    },
  });

  let claimed: EmailFinding | undefined;
  let findRunId: string | undefined;
  let provisionedCostId: string | null = null;
  let keySource: "org" | "platform" | undefined;
  // What the vendor answered, once it has. From then on it may have billed us:
  // a later failure (runs-service, our DB) must neither release the hold before
  // the charge is declared, nor let a retry declare it a second time after.
  let answered: VendorFindResult | null = null;
  let answeredCallId: string | null = null;
  let chargeDeclared = false;
  let actualCostId: string | null = null;

  try {
    const existing = await findExisting(vendor, preset, personKey);
    if (existing && isSettledOrInFlight(existing)) {
      return await respond(existing, true);
    }

    const resolved = await resolveKey(orgId, userId!, plan.keyProvider, tracking, ctx.callerPath);
    keySource = resolved.keySource;
    // treg's token is team-scoped: the team slug is its own key-service entry.
    const tregOrg = vendor === "treg" ? (await resolveKey(orgId, userId!, "treg-org", tracking, ctx.callerPath)).key : null;

    if (keySource === "platform") {
      const auth = await authorizeCredit({
        // billing-service authorizes INTEGER quantities only (Explee basic is
        // 1.5 credits). Authorize is an affordability gate, so round the worst
        // case UP; runs-service takes the exact decimal on provision/actual.
        items: [{ costName: plan.costName, quantity: Math.ceil(plan.maxQuantity) }],
        description: `${vendor} email find`,
        orgId: orgId,
        userId: userId!,
        runId,
        ...tracking,
      });
      if (!auth.sufficient) {
        return { status: 402, body: {
          type: "credit_insufficient",
          error: "Insufficient credits",
          balance_cents: auth.balance_cents,
          required_cents: auth.required_cents,
        } };
      }
    }

    // CLAIM the (vendor, preset, person) slot. Exactly one request wins it; a
    // concurrent loser serves whatever the winner wrote.
    const claimFields = {
      apolloPersonId: person.apolloPersonId ?? null,
      firstName: person.firstName ?? null,
      lastName: person.lastName ?? null,
      domain: person.domain ? normalizeDomain(person.domain) : null,
      linkedinUrl: person.linkedinUrl ?? null,
      orgId: orgId,
      userId: userId,
      runId,
      brandIds,
      campaignId,
      status: "pending",
      costName: plan.costName,
      chargedUnit: plan.chargedUnit,
      keySource,
      failureReason: null,
      requestedAt: new Date(),
      updatedAt: new Date(),
    };
    // A failed finding that KEPT its hold (the vendor may have billed: a lost
    // answer) is released once this retry learns the truth — treg replays the
    // original answer free under the same Idempotency-Key and reports the
    // original charge, which this run then declares as `actual`.
    const keptHold =
      existing?.status === "failed" && existing.findRunId && existing.provisionedCostId
        ? { runId: existing.findRunId, costId: existing.provisionedCostId }
        : null;
    if (existing) {
      [claimed] = await db
        .update(emailFindings)
        .set(claimFields)
        .where(and(eq(emailFindings.id, existing.id), eq(emailFindings.status, "failed")))
        .returning();
    } else {
      [claimed] = await db
        .insert(emailFindings)
        .values({ vendor, preset, personKey, ...claimFields })
        .onConflictDoNothing({ target: [emailFindings.vendor, emailFindings.preset, emailFindings.personKey] })
        .returning();
    }
    if (!claimed) {
      const winner = await findExisting(vendor, preset, personKey);
      if (!winner) throw new Error("email finding claim lost to a concurrent request, but no row exists");
      return await respond(winner, true);
    }

    const findRun = await createRun({
      orgId: orgId,
      userId: userId,
      brandIds,
      campaignId,
      audienceId,
      featureSlug,
      serviceName: "apollo-service",
      taskName: `email-find-${vendor}`,
      parentRunId: runId,
      workflowSlug,
    });
    findRunId = findRun.id;

    // PROVISION the worst case before EXECUTING.
    const provisioned = await addCosts(
      findRunId,
      [{ costName: plan.costName, costSource: keySource, quantity: plan.maxQuantity, status: "provisioned" }],
      identity
    );
    provisionedCostId = provisioned.costs?.[0]?.id ?? null;
    if (!provisionedCostId) throw new Error(`runs-service returned no cost id for the ${plan.costName} hold`);

    traceEvent(runId, { service: "apollo-service", event: "email-find-start", detail: `vendor=${vendor}, preset=${preset}, person=${personKey}` }, headers).catch(() => {});

    // EXECUTE.
    let result: VendorFindResult;
    try {
      result =
        vendor === "treg"
          ? await findWithTreg(resolved.key, tregOrg!, person, `apollo-email-find:${claimed.id}`)
          : await findWithExplee(resolved.key, person, preset as ExpleePreset);
    } catch (err) {
      if (err instanceof EmailFinderVendorError) {
        const callId = await writeBronze({
          findingId: claimed.id,
          vendor,
          preset,
          orgId: orgId,
          userId: userId,
          runId,
          findRunId,
          exchange: err.exchange,
          underlyingProvider: null,
          chargedQuantity: null,
          chargedUnit: plan.chargedUnit,
          error: err.message,
        });
        await db.update(emailFindings).set({ lastCallId: callId }).where(eq(emailFindings.id, claimed.id));
      }
      throw err;
    }
    answered = result;

    const callId = await writeBronze({
      findingId: claimed.id,
      vendor,
      preset,
      orgId: orgId,
      userId: userId,
      runId,
      findRunId,
      exchange: result.exchange,
      underlyingProvider: result.underlyingProvider,
      chargedQuantity: result.chargedQuantity,
      chargedUnit: plan.chargedUnit,
      error: null,
    });
    answeredCallId = callId;

    // ACTUALIZE / CANCEL. The hold was the worst case; the vendor reported the
    // exact charge, so post that as `actual` and release the hold (runs PATCH
    // is status-only). A miss charged 0 → the hold is simply released. A treg
    // call still pending keeps its hold: it may yet charge.
    if (result.outcome !== "pending") {
      const charged = result.chargedQuantity ?? 0;
      if (charged > 0) {
        const actual = await addCosts(
          findRunId,
          [{ costName: plan.costName, costSource: keySource, quantity: charged, status: "actual" }],
          identity
        );
        actualCostId = actual.costs?.[0]?.id ?? null;
      }
      chargeDeclared = true;
      await updateCostStatus(findRunId, provisionedCostId, "cancelled", identity);
      await updateRun(findRunId, "completed", identity);
      if (keptHold) await updateCostStatus(keptHold.runId, keptHold.costId, "cancelled", identity);
    }

    const [done] = await db
      .update(emailFindings)
      .set({
        status: result.outcome,
        email: result.email,
        vendorMailboxStatus: result.vendorMailboxStatus,
        mailboxStatus: result.mailboxStatus,
        underlyingProvider: result.underlyingProvider,
        chargedQuantity: result.chargedQuantity === null ? null : String(result.chargedQuantity),
        rejectedEmail: result.rejectedEmail,
        rejectionReason: result.rejectionReason,
        findRunId,
        provisionedCostId,
        actualCostId,
        lastCallId: callId,
        completedAt: result.outcome === "pending" ? null : new Date(),
        updatedAt: new Date(),
      })
      .where(eq(emailFindings.id, claimed.id))
      .returning();

    traceEvent(
      runId,
      { service: "apollo-service", event: "email-find-done", detail: `vendor=${vendor}, status=${result.outcome}, charged=${result.chargedQuantity}` },
      headers
    ).catch(() => {});

    return await respond(done, false);
  } catch (error) {
    console.error("[Apollo Service][POST /email-finder/find] ERROR:", error);
    const message = error instanceof Error ? error.message : "Internal server error";

    // The find itself succeeded and is stored; only its verdict is missing. A
    // re-request serves the finding (no vendor call) and retries the verify.
    if (error instanceof EmailVerificationError) {
      return { status: 502, body: { type: "email_verification", source: "email-verification", error: message } };
    }

    // Release what we reserved, unless the vendor may have billed us anyway.
    // Also true once the vendor answered: a runs-service timeout while declaring
    // a charge treg already made must not release the hold (the retry replays
    // free under the same Idempotency-Key and declares the charge).
    // Answered but the charge not yet declared (e.g. runs-service timed out on
    // the `actual`): keep the hold, like a lost answer. treg replays the answer
    // free under the same Idempotency-Key on retry and the charge is declared then.
    const mayHaveCharged =
      (answered !== null && !chargeDeclared) || (error instanceof EmailFinderVendorError && error.mayHaveCharged);
    // Answered AND the charge declared: the finding is settled. Store it as such
    // so no retry calls the vendor or declares the charge a second time.
    const settled = answered !== null && chargeDeclared ? answered : null;
    try {
      if (claimed && settled) {
        await db
          .update(emailFindings)
          .set({
            status: settled.outcome,
            email: settled.email,
            vendorMailboxStatus: settled.vendorMailboxStatus,
            mailboxStatus: settled.mailboxStatus,
            underlyingProvider: settled.underlyingProvider,
            chargedQuantity: settled.chargedQuantity === null ? null : String(settled.chargedQuantity),
            rejectedEmail: settled.rejectedEmail,
            rejectionReason: settled.rejectionReason,
            findRunId,
            provisionedCostId,
            actualCostId,
            lastCallId: answeredCallId,
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(emailFindings.id, claimed.id));
      } else if (claimed) {
        await db
          .update(emailFindings)
          // `provisionedCostId` survives ONLY when the hold was kept, so a
          // later retry knows exactly which hold it still owes a release.
          .set({
            status: "failed",
            failureReason: message,
            findRunId,
            provisionedCostId: mayHaveCharged ? provisionedCostId : null,
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(emailFindings.id, claimed.id));
      }
      if (findRunId && provisionedCostId && !mayHaveCharged) {
        await updateCostStatus(findRunId, provisionedCostId, "cancelled", identity);
      }
      if (findRunId) await updateRun(findRunId, "failed", identity);
    } catch (cleanupError) {
      console.error("[Apollo Service][POST /email-finder/find] cleanup after failure also failed:", cleanupError);
    }

    traceEvent(runId, { service: "apollo-service", event: "email-find-error", detail: message, level: "error" }, headers).catch(() => {});

    if (error instanceof ProviderKeyMissingError) {
      return { status: 503, body: { type: "provider_key_missing", error: message } };
    }
    if (error instanceof EmailFinderVendorError) {
      return { status: 502, body: { type: "vendor_error", vendor: error.vendor, error: message, holdKept: mayHaveCharged } };
    }
    return { status: 500, body: { type: "internal", error: message } };
  }
}

