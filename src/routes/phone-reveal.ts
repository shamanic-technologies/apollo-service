import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { apolloPhoneReveals, type ApolloPhoneReveal } from "../db/schema.js";
import { serviceAuth, orgAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { enrichPerson, buildPhoneRevealWebhookUrl } from "../lib/apollo-client.js";
import { providerErrorFields } from "../lib/provider-error.js";
import { advisoryXactLock } from "../lib/advisory-lock.js";
import { decryptKey } from "../lib/keys-client.js";
import { createRun, updateRun, addCosts, updateCostStatus, type IdentityHeaders } from "../lib/runs-client.js";
import { authorizeCredit } from "../lib/billing-client.js";
import { assertKeySource } from "../lib/validators.js";
import { toCreditAlertIdentity } from "../lib/credit-alert.js";
import { traceEvent } from "../lib/trace-event.js";
import {
  PHONE_REVEAL_COST_NAME,
  PHONE_REVEAL_MAX_CREDITS,
  phonesForPerson,
  pickPrimaryPhone,
  primaryNumber,
  type RevealedPhone,
} from "../lib/phone-reveal.js";

const router = Router();

/** Lock key so two concurrent reveals for the same person spend only once. */
function revealLockKey(orgId: string, apolloPersonId: string): string {
  return `apollo-phone-reveal:${orgId}:${apolloPersonId}`;
}

/**
 * The wire shape both the request and the read return. `status` is what lets a
 * consumer tell "not here yet" (pending) from "Apollo found nothing"
 * (not_found) from "the reveal failed" (failed) — it never has to infer any of
 * those from a null number.
 */
export function toRevealResponse(row: ApolloPhoneReveal) {
  const phoneNumbers = (row.phoneNumbers ?? []) as RevealedPhone[];
  const primary = pickPrimaryPhone(phoneNumbers);
  return {
    revealId: row.id,
    apolloPersonId: row.apolloPersonId,
    status: row.status,
    mobilePhone: row.mobilePhone ?? primaryNumber(primary),
    dncStatus: row.dncStatus ?? primary?.dncStatus ?? null,
    doNotCall: primary?.doNotCall ?? false,
    phoneNumbers,
    failureReason: row.failureReason ?? null,
    creditsConsumed: row.creditsConsumed ?? null,
    requestedAt: row.requestedAt?.toISOString?.() ?? row.requestedAt ?? null,
    completedAt: row.completedAt?.toISOString?.() ?? row.completedAt ?? null,
  };
}

async function latestReveal(orgId: string, apolloPersonId: string): Promise<ApolloPhoneReveal | undefined> {
  const [row] = await db
    .select()
    .from(apolloPhoneReveals)
    .where(and(eq(apolloPhoneReveals.orgId, orgId), eq(apolloPhoneReveals.apolloPersonId, apolloPersonId)))
    .orderBy(desc(apolloPhoneReveals.requestedAt))
    .limit(1);
  return row;
}

/**
 * POST /people/{apolloPersonId}/phone-reveal — ask Apollo to reveal this
 * person's phone number, and pay for it.
 *
 * Opt-in by construction: it is a route of its own, so no existing enrichment
 * caller can trip a reveal, and nobody starts paying reveal credits by
 * accident. Apollo answers WITHOUT the number and delivers it minutes later to
 * /webhook/phone-reveal, so this returns 202 + status "pending" and the caller
 * polls the GET.
 */
router.post("/people/:apolloPersonId/phone-reveal", serviceAuth, async (req: AuthenticatedRequest, res) => {
  const apolloPersonId = String(req.params.apolloPersonId ?? "").trim();
  try {
    const { runId, brandIds, campaignId, audienceId, featureSlug, workflowSlug } = req;
    if (!apolloPersonId) {
      return res.status(400).json({ type: "validation", error: "apolloPersonId path param required" });
    }
    if (!runId) {
      return res.status(400).json({ type: "validation", error: "x-run-id header required" });
    }

    const identity: IdentityHeaders = { orgId: req.orgId!, userId: req.userId, brandIds, campaignId, audienceId, featureSlug, workflowSlug };
    const tracking = { brandIds, campaignId, audienceId, featureSlug, workflowSlug };

    traceEvent(runId, { service: "apollo-service", event: "phone-reveal-start", detail: `apolloPersonId=${apolloPersonId}` }, req.headers).catch(() => {});

    // Already revealed, or a reveal already in flight: serve it, spend nothing.
    // A `not_found`/`failed` row is NOT reused — Apollo charges zero when it
    // finds nothing, so retrying later is free and may pick up new data.
    const existing = await latestReveal(req.orgId!, apolloPersonId);
    if (existing && (existing.status === "found" || existing.status === "pending")) {
      return res.status(existing.status === "found" ? 200 : 202).json({ ...toRevealResponse(existing), reused: true });
    }

    // Apollo REQUIRES a callback for a reveal, and without one the number can
    // never reach us — fail loud before spending a credit.
    const webhookUrl = buildPhoneRevealWebhookUrl();
    if (!webhookUrl) {
      throw new Error(
        "Phone reveal callback is not configured — APOLLO_SERVICE_PUBLIC_URL and APOLLO_PHONE_REVEAL_WEBHOOK_SECRET are both required"
      );
    }

    const { key: apolloApiKey, keySource } = await decryptKey(
      req.orgId!,
      req.userId!,
      "apollo",
      { callerMethod: "POST", callerPath: "/people/{apolloPersonId}/phone-reveal" },
      tracking
    );
    assertKeySource(keySource);

    // AUTHORIZE the worst case (a reveal that returns a mobile) before calling.
    // BYOK orgs pay Apollo directly, so no affordability gate applies to them.
    if (keySource === "platform") {
      const auth = await authorizeCredit({
        items: [{ costName: PHONE_REVEAL_COST_NAME, quantity: PHONE_REVEAL_MAX_CREDITS }],
        description: PHONE_REVEAL_COST_NAME,
        orgId: req.orgId!,
        userId: req.userId!,
        runId,
        brandIds,
        campaignId,
        audienceId,
        featureSlug,
        workflowSlug,
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

    const outcome = await db.transaction(async (tx) => {
      await advisoryXactLock(tx, revealLockKey(req.orgId!, apolloPersonId));

      // Re-check under the lock — a concurrent request may have started one.
      const recheck = await latestReveal(req.orgId!, apolloPersonId);
      if (recheck && (recheck.status === "found" || recheck.status === "pending")) {
        return { kind: "reused" as const, row: recheck };
      }

      const revealRun = await createRun({
        orgId: req.orgId!,
        userId: req.userId,
        brandIds,
        campaignId,
        audienceId,
        featureSlug,
        serviceName: "apollo-service",
        taskName: "phone-reveal",
        parentRunId: runId,
        workflowSlug,
      });

      // PROVISION the hold before EXECUTING. The callback actualizes it when a
      // number arrives and cancels it when none does, so nothing is charged
      // when Apollo finds nothing.
      const provisioned = await addCosts(
        revealRun.id,
        [{ costName: PHONE_REVEAL_COST_NAME, costSource: keySource, quantity: PHONE_REVEAL_MAX_CREDITS, status: "provisioned" }],
        identity
      );
      const provisionedCostId = provisioned.costs?.[0]?.id ?? null;

      const [row] = await tx
        .insert(apolloPhoneReveals)
        .values({
          orgId: req.orgId!,
          userId: req.userId,
          apolloPersonId,
          runId,
          revealRunId: revealRun.id,
          brandIds,
          campaignId,
          audienceId,
          featureSlug,
          workflowSlug,
          status: "pending",
          keySource,
          provisionedCostId,
        })
        .returning();

      try {
        const result = await enrichPerson(apolloApiKey, apolloPersonId, webhookUrl, toCreditAlertIdentity(req), {
          revealPhoneNumber: true,
        });

        const apolloRequestId = result.request_id !== undefined && result.request_id !== null ? String(result.request_id) : null;

        // Apollo normally answers WITHOUT the number. If it did include one,
        // finish here rather than waiting for a callback that adds nothing.
        const phones = result.person ? phonesForPerson(result.person) : [];
        if (phones.length > 0) {
          const primary = pickPrimaryPhone(phones);
          const [completed] = await tx
            .update(apolloPhoneReveals)
            .set({
              apolloRequestId,
              status: "found",
              mobilePhone: primaryNumber(primary),
              dncStatus: primary?.dncStatus ?? null,
              phoneNumbers: phones,
              creditsConsumed: PHONE_REVEAL_MAX_CREDITS,
              costReconciledAt: new Date(),
              completedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(apolloPhoneReveals.id, row.id))
            .returning();

          if (provisionedCostId) {
            await updateCostStatus(revealRun.id, provisionedCostId, "actual", identity);
          }
          await updateRun(revealRun.id, "completed", identity);
          return { kind: "found" as const, row: completed };
        }

        const [pending] = await tx
          .update(apolloPhoneReveals)
          .set({ apolloRequestId, updatedAt: new Date() })
          .where(eq(apolloPhoneReveals.id, row.id))
          .returning();
        return { kind: "pending" as const, row: pending };
      } catch (apolloError) {
        // The reveal failed. Release the hold, mark the row, and rethrow — the
        // caller is told plainly rather than left polling a row that will never
        // move. Nothing about the person's email/demographics is touched.
        await tx
          .update(apolloPhoneReveals)
          .set({
            status: "failed",
            failureReason: apolloError instanceof Error ? apolloError.message : "Apollo phone reveal failed",
            costReconciledAt: new Date(),
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(apolloPhoneReveals.id, row.id));
        if (provisionedCostId) {
          await updateCostStatus(revealRun.id, provisionedCostId, "cancelled", identity);
        }
        await updateRun(revealRun.id, "failed", identity);
        throw apolloError;
      }
    });

    traceEvent(
      runId,
      { service: "apollo-service", event: "phone-reveal-requested", detail: `apolloPersonId=${apolloPersonId}, status=${outcome.row.status}` },
      req.headers
    ).catch(() => {});

    const body = toRevealResponse(outcome.row);
    return res.status(outcome.kind === "found" ? 200 : 202).json(outcome.kind === "reused" ? { ...body, reused: true } : body);
  } catch (error) {
    console.error("[Apollo Service][POST /people/:apolloPersonId/phone-reveal] ERROR:", error);
    if (req.runId) {
      traceEvent(
        req.runId,
        { service: "apollo-service", event: "phone-reveal-error", detail: error instanceof Error ? error.message : "Unknown error", level: "error" },
        req.headers
      ).catch(() => {});
    }
    res.status(500).json({
      type: "internal",
      error: error instanceof Error ? error.message : "Internal server error",
      ...providerErrorFields(error),
    });
  }
});

/**
 * GET /people/{apolloPersonId}/phone-reveal — has the number arrived yet?
 *
 * The consumer polls this for its bounded wait and proceeds either way. 404
 * means no reveal was ever requested for this person, which is distinct from
 * every `status` value the row can carry.
 */
router.get("/people/:apolloPersonId/phone-reveal", orgAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const apolloPersonId = String(req.params.apolloPersonId ?? "").trim();
    if (!apolloPersonId) {
      return res.status(400).json({ type: "validation", error: "apolloPersonId path param required" });
    }

    const row = await latestReveal(req.orgId!, apolloPersonId);
    if (!row) {
      return res.status(404).json({ type: "not_found", error: "No phone reveal has been requested for this person" });
    }

    return res.json(toRevealResponse(row));
  } catch (error) {
    console.error("[Apollo Service][GET /people/:apolloPersonId/phone-reveal] ERROR:", error);
    res.status(500).json({ type: "internal", error: error instanceof Error ? error.message : "Internal server error" });
  }
});

export default router;
