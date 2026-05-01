import { Router, Request, Response } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { apolloPeopleEnrichments } from "../db/schema.js";
import { createRun, updateRun, addCosts, type IdentityHeaders } from "../lib/runs-client.js";
import type { EmailStatus } from "../schemas.js";
import { traceEvent } from "../lib/trace-event.js";

const router = Router();

const APOLLO_WATERFALL_WEBHOOK_SECRET = process.env.APOLLO_WATERFALL_WEBHOOK_SECRET || "";

interface WaterfallVendor {
  id: string;
  name: string;
  status: string;
  emails?: string[];
}

interface WaterfallPersonPayload {
  id: string; // Apollo person ID
  waterfall?: {
    emails?: Array<{ vendors: WaterfallVendor[] }>;
  };
  emails?: Array<{ email: string; email_status?: EmailStatus }>;
}

interface WaterfallWebhookPayload {
  status: string;
  request_id: string;
  credits_consumed: number;
  total_requested_enrichments: number;
  records_enriched: number;
  email_records_enriched: number;
  email_records_not_found: number;
  people: WaterfallPersonPayload[];
}

/**
 * Parse the webhook body with safe request_id handling.
 * Apollo sends request_id as a large integer that exceeds Number.MAX_SAFE_INTEGER.
 * Express's JSON parser (JSON.parse) loses precision on these values.
 * We re-parse from the raw body to preserve the exact digits.
 */
function safeRequestId(req: Request): string {
  const rawBody = (req as any).rawBody as string | undefined;
  if (rawBody) {
    const match = rawBody.match(/"request_id"\s*:\s*(-?\d+)/);
    if (match) return match[1];
  }
  return String(req.body?.request_id ?? "");
}

/**
 * POST /webhook/waterfall - Apollo waterfall enrichment callback
 * Public endpoint authenticated via secret query param.
 */
router.post("/webhook/waterfall", async (req: Request, res: Response) => {
  try {
    const secret = req.query.secret as string;
    if (!APOLLO_WATERFALL_WEBHOOK_SECRET || secret !== APOLLO_WATERFALL_WEBHOOK_SECRET) {
      return res.status(401).json({ error: "Invalid webhook secret" });
    }

    const payload = req.body as WaterfallWebhookPayload;
    const requestId = safeRequestId(req);

    if (!requestId || !payload.people?.length) {
      console.warn("[Apollo Service][webhook/waterfall] Empty payload or missing request_id", { requestId });
      return res.status(200).json({ received: true, updated: 0 });
    }

    const creditsConsumed = payload.credits_consumed ?? 0;

    console.log("[Apollo Service][webhook/waterfall] Received", {
      requestId,
      status: payload.status,
      peopleCount: payload.people.length,
      creditsConsumed,
      emailRecordsEnriched: payload.email_records_enriched,
    });

    // Find all pending enrichments for this request
    const pendingEnrichments = await db
      .select()
      .from(apolloPeopleEnrichments)
      .where(
        and(
          eq(apolloPeopleEnrichments.waterfallRequestId, requestId),
          eq(apolloPeopleEnrichments.waterfallStatus, "pending")
        )
      );

    if (pendingEnrichments.length === 0) {
      console.warn("[Apollo Service][webhook/waterfall] No pending enrichments for request_id", requestId);
      return res.status(200).json({ received: true, updated: 0 });
    }

    // Fire-and-forget trace using the first enrichment's run context
    const firstEnrichment = pendingEnrichments[0];
    const webhookTraceHeaders: Record<string, string | undefined> = {
      "x-org-id": firstEnrichment.orgId,
      "x-brand-id": firstEnrichment.brandIds?.join(","),
      "x-campaign-id": firstEnrichment.campaignId ?? undefined,
    };
    if (firstEnrichment.enrichmentRunId) {
      traceEvent(firstEnrichment.enrichmentRunId, { service: "apollo-service", event: "waterfall-webhook-received", detail: `requestId=${requestId}, peopleCount=${payload.people.length}, creditsConsumed=${creditsConsumed}`, data: { requestId, peopleCount: payload.people.length, creditsConsumed } }, webhookTraceHeaders).catch(() => {});
    }

    // Index pending enrichments by Apollo person ID for fast lookup
    const enrichmentByPersonId = new Map(
      pendingEnrichments
        .filter((e) => e.apolloPersonId)
        .map((e) => [e.apolloPersonId!, e])
    );

    // Process each person: update DB records
    let updated = 0;

    for (const person of payload.people) {
      const enrichment = enrichmentByPersonId.get(person.id);
      if (!enrichment) continue;

      // Extract best email from webhook response
      const webhookEmail = person.emails?.[0]?.email ?? null;
      const webhookEmailStatus = person.emails?.[0]?.email_status ?? null;

      // Extract vendor name that found the email
      const vendorName = person.waterfall?.emails?.[0]?.vendors?.[0]?.name ?? null;

      if (!webhookEmail) {
        // Waterfall ran but found nothing
        await db
          .update(apolloPeopleEnrichments)
          .set({ waterfallStatus: "failed" })
          .where(eq(apolloPeopleEnrichments.id, enrichment.id));
        updated++;
        continue;
      }

      // Update enrichment with the waterfall email
      await db
        .update(apolloPeopleEnrichments)
        .set({
          email: webhookEmail,
          emailStatus: webhookEmailStatus ?? "verified",
          waterfallStatus: "completed",
          waterfallSource: vendorName,
        })
        .where(eq(apolloPeopleEnrichments.id, enrichment.id));

      updated++;
    }

    // Track waterfall cost ONCE for the entire batch (not per person)
    if (creditsConsumed > 0 && firstEnrichment.enrichmentRunId) {
      const identity: IdentityHeaders = {
        orgId: firstEnrichment.orgId,
        brandId: firstEnrichment.brandIds.join(","),
        campaignId: firstEnrichment.campaignId,
      };
      const costSource = (firstEnrichment.keySource as "platform" | "org") ?? "platform";

      try {
        const waterfallRun = await createRun({
          orgId: firstEnrichment.orgId,
          brandId: firstEnrichment.brandIds.join(","),
          campaignId: firstEnrichment.campaignId,
          featureSlug: firstEnrichment.featureSlug ?? undefined,
          serviceName: "apollo-service",
          taskName: "waterfall-enrichment",
          parentRunId: firstEnrichment.enrichmentRunId,
          workflowSlug: firstEnrichment.workflowSlug ?? undefined,
        });

        await addCosts(
          waterfallRun.id,
          [{ costName: "apollo-credit", costSource, quantity: creditsConsumed }],
          identity
        );
        await updateRun(waterfallRun.id, "completed", identity);
      } catch (err) {
        console.error("[Apollo Service][webhook/waterfall] Failed to track waterfall cost", err);
      }
    }

    console.log("[Apollo Service][webhook/waterfall] Processed", { requestId, updated, total: payload.people.length, creditsConsumed });

    if (firstEnrichment.enrichmentRunId) {
      traceEvent(firstEnrichment.enrichmentRunId, { service: "apollo-service", event: "waterfall-webhook-done", detail: `requestId=${requestId}, updated=${updated}/${payload.people.length}, creditsConsumed=${creditsConsumed}`, data: { requestId, updated, total: payload.people.length, creditsConsumed } }, webhookTraceHeaders).catch(() => {});
    }

    res.status(200).json({ received: true, updated });
  } catch (error) {
    console.error("[Apollo Service][webhook/waterfall] ERROR:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
