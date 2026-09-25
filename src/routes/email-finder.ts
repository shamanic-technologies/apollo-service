import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { emailFinderCalls, emailFindings, type EmailFinding } from "../db/schema.js";
import { serviceAuth, orgAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { decryptKey } from "../lib/keys-client.js";
import { createRun, updateRun, addCosts, updateCostStatus, type IdentityHeaders } from "../lib/runs-client.js";
import { authorizeCredit } from "../lib/billing-client.js";
import { assertKeySource } from "../lib/validators.js";
import { traceEvent } from "../lib/trace-event.js";
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
} from "../lib/email-finders.js";

const router = Router();

export const EmailFindPersonSchema = z.object({
  apolloPersonId: z.string().min(1).optional(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  domain: z.string().min(1).optional(),
  linkedinUrl: z.string().min(1).optional(),
});

export const EmailFindRequestSchema = z
  .object({
    vendor: z.enum(["treg", "explee"]),
    preset: z.enum(["basic", "premium"]).optional(),
    person: EmailFindPersonSchema,
  })
  .superRefine((body, ctx) => {
    const p = body.person;
    const hasName = !!(p.firstName && p.lastName && p.domain);
    if (body.vendor === "explee") {
      if (!body.preset) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["preset"], message: "explee requires preset: basic | premium" });
      if (!hasName) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["person"], message: "explee requires firstName, lastName and domain" });
    } else {
      if (body.preset) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["preset"], message: "treg takes no preset" });
      if (!hasName && !p.linkedinUrl) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["person"], message: "treg requires linkedinUrl, or firstName + lastName + domain" });
      }
    }
  });

type Vendor = EmailFinderVendor;

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

async function resolveKey(req: AuthenticatedRequest, provider: string, tracking: Record<string, unknown>) {
  try {
    const resolved = await decryptKey(req.orgId!, req.userId!, provider, { callerMethod: "POST", callerPath: "/email-finder/find" }, tracking);
    assertKeySource(resolved.keySource);
    if (!resolved.key) throw new Error("key-service returned an empty key");
    return resolved;
  } catch (err) {
    throw new ProviderKeyMissingError(
      `No usable "${provider}" key in key-service (platform provider "${provider}"): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * POST /email-finder/find — ask treg or Explee for a person's work email.
 *
 * Idempotent on (vendor, preset, person): a finding that is found, not found,
 * or still in flight is served from the silver row and the vendor is never
 * called again, so a re-run never pays twice. Only a `failed` finding (the
 * vendor answered with an error, which it does not bill) is retried.
 */
router.post("/email-finder/find", serviceAuth, async (req: AuthenticatedRequest, res) => {
  const parsed = EmailFindRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ type: "validation", error: "Invalid request", details: parsed.error.flatten() });
  }
  const { runId, brandIds, campaignId, audienceId, featureSlug, workflowSlug } = req;
  if (!runId) {
    return res.status(400).json({ type: "validation", error: "x-run-id header required" });
  }

  const vendor = parsed.data.vendor;
  const preset = vendor === "treg" ? TREG_PRESET : (parsed.data.preset as ExpleePreset);
  const person: FindPerson = parsed.data.person;
  const personKey = personKeyOf(person);
  const plan = planFor(vendor, preset);
  const identity: IdentityHeaders = { orgId: req.orgId!, userId: req.userId, brandIds, campaignId, audienceId, featureSlug, workflowSlug };
  const tracking = { brandIds, campaignId, audienceId, featureSlug, workflowSlug };

  let claimed: EmailFinding | undefined;
  let findRunId: string | undefined;
  let provisionedCostId: string | null = null;
  let keySource: "org" | "platform" | undefined;

  try {
    const existing = await findExisting(vendor, preset, personKey);
    if (existing && isSettledOrInFlight(existing)) {
      return res.status(statusCodeFor(existing)).json({ ...toFindingResponse(existing), reused: true });
    }

    const resolved = await resolveKey(req, plan.keyProvider, tracking);
    keySource = resolved.keySource;

    if (keySource === "platform") {
      const auth = await authorizeCredit({
        items: [{ costName: plan.costName, quantity: plan.maxQuantity }],
        description: `${vendor} email find`,
        orgId: req.orgId!,
        userId: req.userId!,
        runId,
        ...tracking,
      });
      if (!auth.sufficient) {
        return res.status(402).json({
          type: "credit_insufficient",
          error: "Insufficient credits",
          balance_cents: auth.balance_cents,
          required_cents: auth.required_cents,
        });
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
      orgId: req.orgId!,
      userId: req.userId,
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
      return res.status(statusCodeFor(winner)).json({ ...toFindingResponse(winner), reused: true });
    }

    const findRun = await createRun({
      orgId: req.orgId!,
      userId: req.userId,
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

    traceEvent(runId, { service: "apollo-service", event: "email-find-start", detail: `vendor=${vendor}, preset=${preset}, person=${personKey}` }, req.headers).catch(() => {});

    // EXECUTE.
    let result: VendorFindResult;
    try {
      result =
        vendor === "treg"
          ? await findWithTreg(resolved.key, person, `apollo-email-find:${claimed.id}`)
          : await findWithExplee(resolved.key, person, preset as ExpleePreset);
    } catch (err) {
      if (err instanceof EmailFinderVendorError) {
        const callId = await writeBronze({
          findingId: claimed.id,
          vendor,
          preset,
          orgId: req.orgId!,
          userId: req.userId,
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

    const callId = await writeBronze({
      findingId: claimed.id,
      vendor,
      preset,
      orgId: req.orgId!,
      userId: req.userId,
      runId,
      findRunId,
      exchange: result.exchange,
      underlyingProvider: result.underlyingProvider,
      chargedQuantity: result.chargedQuantity,
      chargedUnit: plan.chargedUnit,
      error: null,
    });

    // ACTUALIZE / CANCEL. The hold was the worst case; the vendor reported the
    // exact charge, so post that as `actual` and release the hold (runs PATCH
    // is status-only). A miss charged 0 → the hold is simply released. A treg
    // call still pending keeps its hold: it may yet charge.
    let actualCostId: string | null = null;
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
      await updateCostStatus(findRunId, provisionedCostId, "cancelled", identity);
      await updateRun(findRunId, "completed", identity);
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
      req.headers
    ).catch(() => {});

    return res.status(statusCodeFor(done)).json({ ...toFindingResponse(done), reused: false });
  } catch (error) {
    console.error("[Apollo Service][POST /email-finder/find] ERROR:", error);
    const message = error instanceof Error ? error.message : "Internal server error";

    // Release what we reserved, unless the vendor may have billed us anyway.
    const mayHaveCharged = error instanceof EmailFinderVendorError && error.mayHaveCharged;
    try {
      if (claimed) {
        await db
          .update(emailFindings)
          .set({ status: "failed", failureReason: message, findRunId, provisionedCostId, completedAt: new Date(), updatedAt: new Date() })
          .where(eq(emailFindings.id, claimed.id));
      }
      if (findRunId && provisionedCostId && !mayHaveCharged) {
        await updateCostStatus(findRunId, provisionedCostId, "cancelled", identity);
      }
      if (findRunId) await updateRun(findRunId, "failed", identity);
    } catch (cleanupError) {
      console.error("[Apollo Service][POST /email-finder/find] cleanup after failure also failed:", cleanupError);
    }

    traceEvent(runId, { service: "apollo-service", event: "email-find-error", detail: message, level: "error" }, req.headers).catch(() => {});

    if (error instanceof ProviderKeyMissingError) {
      return res.status(503).json({ type: "provider_key_missing", error: message });
    }
    if (error instanceof EmailFinderVendorError) {
      return res.status(502).json({ type: "vendor_error", vendor: error.vendor, error: message, holdKept: mayHaveCharged });
    }
    return res.status(500).json({ type: "internal", error: message });
  }
});

/**
 * GET /email-finder/findings?apolloPersonId=… — every finding held for a
 * person, across vendors and presets. Reads silver only; calls no vendor.
 */
router.get("/email-finder/findings", orgAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const apolloPersonId = String(req.query.apolloPersonId ?? "").trim();
    if (!apolloPersonId) {
      return res.status(400).json({ type: "validation", error: "apolloPersonId query param required" });
    }
    const rows = await db.select().from(emailFindings).where(eq(emailFindings.apolloPersonId, apolloPersonId));
    return res.json({ findings: rows.map(toFindingResponse) });
  } catch (error) {
    console.error("[Apollo Service][GET /email-finder/findings] ERROR:", error);
    res.status(500).json({ type: "internal", error: error instanceof Error ? error.message : "Internal server error" });
  }
});

export default router;
