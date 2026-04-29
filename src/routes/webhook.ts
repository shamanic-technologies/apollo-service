import { Router, Request, Response } from "express";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { apolloPeopleEnrichments } from "../db/schema.js";
import { createRun, updateRun, addCosts, type IdentityHeaders } from "../lib/runs-client.js";

const router = Router();

const WATERFALL_WEBHOOK_SECRET = process.env.WATERFALL_WEBHOOK_SECRET || "";

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
  emails?: Array<{ email: string; email_status?: string }>;
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
 * POST /webhook/waterfall - Apollo waterfall enrichment callback
 * Public endpoint authenticated via secret query param.
 */
router.post("/webhook/waterfall", async (req: Request, res: Response) => {
  try {
    const secret = req.query.secret as string;
    if (!WATERFALL_WEBHOOK_SECRET || secret !== WATERFALL_WEBHOOK_SECRET) {
      return res.status(401).json({ error: "Invalid webhook secret" });
    }

    const payload = req.body as WaterfallWebhookPayload;
    const requestId = String(payload.request_id);

    if (!requestId || !payload.people?.length) {
      console.warn("[Apollo Service][webhook/waterfall] Empty payload or missing request_id", { requestId });
      return res.status(200).json({ received: true, updated: 0 });
    }

    console.log("[Apollo Service][webhook/waterfall] Received", {
      requestId,
      status: payload.status,
      peopleCount: payload.people.length,
      creditsConsumed: payload.credits_consumed,
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

    // Index pending enrichments by Apollo person ID for fast lookup
    const enrichmentByPersonId = new Map(
      pendingEnrichments
        .filter((e) => e.apolloPersonId)
        .map((e) => [e.apolloPersonId!, e])
    );

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

      // Track waterfall cost in runs-service
      if (enrichment.enrichmentRunId) {
        const identity: IdentityHeaders = {
          orgId: enrichment.orgId,
          brandId: enrichment.brandIds.join(","),
          campaignId: enrichment.campaignId,
        };

        const costSource = (enrichment.keySource as "platform" | "org") ?? "platform";

        try {
          const waterfallRun = await createRun({
            orgId: enrichment.orgId,
            brandId: enrichment.brandIds.join(","),
            campaignId: enrichment.campaignId,
            featureSlug: enrichment.featureSlug ?? undefined,
            serviceName: "apollo-service",
            taskName: "waterfall-enrichment",
            parentRunId: enrichment.enrichmentRunId,
            workflowSlug: enrichment.workflowSlug ?? undefined,
          });

          await addCosts(
            waterfallRun.id,
            [{ costName: "apollo-waterfall-email-credit", costSource, quantity: 1 }],
            identity
          );
          await updateRun(waterfallRun.id, "completed", identity);
        } catch (err) {
          console.error("[Apollo Service][webhook/waterfall] Failed to track cost for enrichment", enrichment.id, err);
        }
      }

      updated++;
    }

    console.log("[Apollo Service][webhook/waterfall] Processed", { requestId, updated, total: payload.people.length });

    res.status(200).json({ received: true, updated });
  } catch (error) {
    console.error("[Apollo Service][webhook/waterfall] ERROR:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
