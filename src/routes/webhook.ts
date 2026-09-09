import { Router, Request, Response } from "express";
import { and, eq, inArray, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { apolloPhoneReveals, apolloPeopleEnrichments, type ApolloPhoneReveal } from "../db/schema.js";
import { addCosts, updateCostStatus, updateRun, type IdentityHeaders } from "../lib/runs-client.js";
import { traceEvent } from "../lib/trace-event.js";
import {
  PHONE_REVEAL_COST_NAME,
  PHONE_REVEAL_MAX_CREDITS,
  peopleFromWebhook,
  personSaysFailed,
  phonesForPerson,
  pickPrimaryPhone,
  primaryNumber,
  webhookSaysFailed,
  type PhoneRevealWebhookPayload,
  type RevealedPhone,
} from "../lib/phone-reveal.js";

const router = Router();

/**
 * POST /webhook/waterfall — DISABLED 2026-05-28.
 *
 * Apollo waterfall (third-party vendor email lookup) was disabled because
 * vendor email quality was unreliable. Direct Apollo /people/match only.
 *
 * Route stays registered as a 200 no-op for ~deploy-window safety: any
 * in-flight waterfall request Apollo dispatched before the deploy may try to
 * deliver a callback here. Returning 200 prevents Apollo's retry storm; the
 * payload is intentionally discarded (no DB update, no cost reconciliation).
 *
 * To revive: restore the original handler body from git history
 * (pre-DIS-68 / pre-2026-05-28) plus the WaterfallVendor /
 * WaterfallPersonPayload / WaterfallWebhookPayload types + safeRequestId
 * helper. See src/lib/waterfall.ts header for the full revive checklist.
 */
router.post("/webhook/waterfall", async (_req: Request, res: Response) => {
  console.log("[Apollo Service][webhook/waterfall] disabled — payload discarded");
  res.status(200).json({ received: true, disabled: true });
});

/**
 * Apollo sends request_id as an integer beyond Number.MAX_SAFE_INTEGER, so
 * express's JSON.parse loses digits. Re-read it from the preserved raw body.
 */
function safeRequestId(req: Request): string {
  const rawBody = (req as any).rawBody as string | undefined;
  if (rawBody) {
    const match = rawBody.match(/"request_id"\s*:\s*(-?\d+)/);
    if (match) return match[1];
  }
  const raw = (req.body as PhoneRevealWebhookPayload | undefined)?.request_id;
  return raw === undefined || raw === null ? "" : String(raw);
}

/** Identity for the cost calls, rebuilt from the row (the request is long gone). */
function identityFor(row: ApolloPhoneReveal): IdentityHeaders {
  return {
    orgId: row.orgId,
    userId: row.userId ?? undefined,
    brandIds: row.brandIds ?? undefined,
    campaignId: row.campaignId ?? undefined,
    audienceId: row.audienceId ?? undefined,
    featureSlug: row.featureSlug ?? undefined,
    workflowSlug: row.workflowSlug ?? undefined,
  };
}

/**
 * Reconcile the pre-call hold against what Apollo actually charged.
 *
 * - a number arrived and Apollo billed the full worst case → flip the hold to actual
 * - a number arrived and Apollo billed less → cancel the hold, post the real quantity
 * - nothing arrived → cancel the hold outright, so the org pays nothing
 *
 * Throws on failure so the caller can answer 5xx and let Apollo redeliver; the
 * retry is safe because rows already reconciled carry `costReconciledAt`.
 */
async function reconcileCost(row: ApolloPhoneReveal, creditsConsumed: number): Promise<void> {
  if (!row.revealRunId) return;
  const identity = identityFor(row);
  const keySource = (row.keySource === "org" ? "org" : "platform") as "org" | "platform";

  if (creditsConsumed <= 0) {
    if (row.provisionedCostId) {
      await updateCostStatus(row.revealRunId, row.provisionedCostId, "cancelled", identity);
    }
    return;
  }

  if (row.provisionedCostId && creditsConsumed === PHONE_REVEAL_MAX_CREDITS) {
    await updateCostStatus(row.revealRunId, row.provisionedCostId, "actual", identity);
    return;
  }

  // runs-service PATCH is status-only (no in-place quantity edit), so a
  // different real quantity means: post the truth, release the hold.
  await addCosts(row.revealRunId, [{ costName: PHONE_REVEAL_COST_NAME, costSource: keySource, quantity: creditsConsumed }], identity);
  if (row.provisionedCostId) {
    await updateCostStatus(row.revealRunId, row.provisionedCostId, "cancelled", identity);
  }
}

/**
 * POST /webhook/phone-reveal — Apollo's asynchronous phone delivery.
 *
 * Apollo answers a reveal request immediately WITHOUT the number and POSTs it
 * here minutes later. This is the only surface on which a phone number ever
 * reaches this service.
 *
 * Answering 2xx for anything we can parse is deliberate: Apollo counts a 4xx
 * exactly like a 5xx and disables a webhook that keeps failing, which would
 * lose every future reveal. The one case that answers 5xx is a cost
 * reconciliation we could not complete — the phone is already committed by
 * then, and the redelivery re-runs only the reconcile (rows already reconciled
 * carry `costReconciledAt` and are skipped).
 */
router.post("/webhook/phone-reveal", async (req: Request, res: Response) => {
  const secret = process.env.APOLLO_PHONE_REVEAL_WEBHOOK_SECRET || "";
  const provided = req.query.secret as string | undefined;
  if (!secret || provided !== secret) {
    console.warn("[Apollo Service][webhook/phone-reveal] rejected — bad or missing secret");
    return res.status(401).json({ type: "validation", error: "Invalid webhook secret" });
  }

  const payload = (req.body ?? {}) as PhoneRevealWebhookPayload;
  const requestId = safeRequestId(req);
  const people = peopleFromWebhook(payload);

  console.log("[Apollo Service][webhook/phone-reveal] received", {
    requestId,
    status: payload.status,
    peopleCount: people.length,
    creditsConsumed: payload.credits_consumed,
  });

  // Find the pending reveals this delivery is about: by Apollo's request_id
  // first (the exact join), falling back to the person ids in the body — a
  // callback that arrives without a usable request_id must still land.
  const personIds = people.map((p) => (p.id ? String(p.id) : "")).filter(Boolean);
  const matchers = [];
  if (requestId) matchers.push(eq(apolloPhoneReveals.apolloRequestId, requestId));
  if (personIds.length > 0) matchers.push(inArray(apolloPhoneReveals.apolloPersonId, personIds));
  if (matchers.length === 0) {
    console.warn("[Apollo Service][webhook/phone-reveal] no request_id and no person ids — nothing to match");
    return res.status(200).json({ received: true, updated: 0 });
  }

  const rows = await db
    .select()
    .from(apolloPhoneReveals)
    .where(and(eq(apolloPhoneReveals.status, "pending"), matchers.length === 1 ? matchers[0] : or(...matchers)));

  if (rows.length === 0) {
    console.warn("[Apollo Service][webhook/phone-reveal] no pending reveal matched", { requestId, personIds });
    return res.status(200).json({ received: true, updated: 0 });
  }

  const phonesByPersonId = new Map<string, RevealedPhone[]>();
  const failedPersonIds = new Set<string>();
  for (const person of people) {
    if (!person.id) continue;
    phonesByPersonId.set(String(person.id), phonesForPerson(person));
    if (personSaysFailed(person)) failedPersonIds.add(String(person.id));
  }

  const failed = webhookSaysFailed(payload);
  const reportedCredits = typeof payload.credits_consumed === "number" ? payload.credits_consumed : null;

  let updated = 0;
  const reconcileErrors: string[] = [];

  for (const row of rows) {
    const phones = phonesByPersonId.get(row.apolloPersonId) ?? [];
    const primary = pickPrimaryPhone(phones);
    const found = phones.length > 0;
    // Absent is a real answer: no number is reported as `not_found`, never as a
    // failure and never as a guess.
    const status = found ? "found" : failed || failedPersonIds.has(row.apolloPersonId) ? "failed" : "not_found";
    const creditsConsumed = reportedCredits ?? (found ? PHONE_REVEAL_MAX_CREDITS : 0);

    // Persist the number FIRST so a reconcile failure can never lose it.
    await db
      .update(apolloPhoneReveals)
      .set({
        status,
        mobilePhone: primaryNumber(primary),
        dncStatus: primary?.dncStatus ?? null,
        phoneNumbers: phones,
        webhookPayload: payload as unknown as Record<string, unknown>,
        creditsConsumed,
        failureReason: status === "failed" ? `Apollo reported status "${payload.status ?? "unknown"}"` : null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(apolloPhoneReveals.id, row.id));
    updated += 1;

    // Mirror onto the person's enrichment rows so a later enrichment read
    // returns the number too — those phone columns have always been empty
    // because a reveal was never requested.
    if (found) {
      await db
        .update(apolloPeopleEnrichments)
        .set({ mobilePhone: primaryNumber(primary), phoneNumbers: phones })
        .where(
          and(
            eq(apolloPeopleEnrichments.orgId, row.orgId),
            eq(apolloPeopleEnrichments.apolloPersonId, row.apolloPersonId)
          )
        );
    }

    if (row.costReconciledAt) continue;
    try {
      await reconcileCost(row, creditsConsumed);
      await db
        .update(apolloPhoneReveals)
        .set({ costReconciledAt: new Date(), updatedAt: new Date() })
        .where(eq(apolloPhoneReveals.id, row.id));
      if (row.revealRunId) {
        await updateRun(row.revealRunId, status === "failed" ? "failed" : "completed", identityFor(row));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "cost reconciliation failed";
      console.error("[Apollo Service][webhook/phone-reveal] cost reconciliation failed", { revealId: row.id, message });
      reconcileErrors.push(message);
    }

    if (row.runId) {
      traceEvent(
        row.runId,
        {
          service: "apollo-service",
          event: "phone-reveal-delivered",
          detail: `apolloPersonId=${row.apolloPersonId}, status=${status}, credits=${creditsConsumed}`,
          data: { apolloPersonId: row.apolloPersonId, status, creditsConsumed },
        },
        { "x-org-id": row.orgId, "x-brand-id": row.brandIds?.join(","), "x-campaign-id": row.campaignId ?? undefined }
      ).catch(() => {});
    }
  }

  if (reconcileErrors.length > 0) {
    // The phone is committed; only the accounting is owed. 5xx so Apollo
    // redelivers and the reconcile is retried — never a silent under-report.
    return res.status(500).json({
      type: "internal",
      error: `Phone stored but cost reconciliation failed: ${reconcileErrors.join("; ")}`,
      received: true,
      updated,
    });
  }

  return res.status(200).json({ received: true, updated });
});

export default router;
