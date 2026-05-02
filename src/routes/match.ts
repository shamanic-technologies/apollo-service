import { Router } from "express";
import { and, gt, eq, isNotNull, desc, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { apolloPeopleEnrichments } from "../db/schema.js";
import { serviceAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { matchPersonByName, buildWaterfallWebhookUrl } from "../lib/apollo-client.js";
import { decryptKey } from "../lib/keys-client.js";
import { createRun, updateRun, addCosts, updateCostStatus, type IdentityHeaders } from "../lib/runs-client.js";
import { authorizeCredit } from "../lib/billing-client.js";
import { transformApolloPerson, toEnrichmentDbValues, transformCachedEnrichment } from "../lib/transform.js";
import { MatchRequestSchema } from "../schemas.js";
import { traceEvent } from "../lib/trace-event.js";
import { assertKeySource } from "../lib/validators.js";

const router = Router();

const WATERFALL_MAX_CREDITS = 20;

function getWaterfallPollIntervalMs(): number {
  return Number(process.env.WATERFALL_POLL_INTERVAL_MS) || 3_000;
}

function getWaterfallPollTimeoutMs(): number {
  return Number(process.env.WATERFALL_POLL_TIMEOUT_MS) || 60_000;
}

/**
 * Look up a cached enrichment by firstName + lastName + organizationDomain.
 * Case-insensitive.
 * - Positive cache (has email): 12-month TTL
 * - Negative cache (no email, waterfall not pending): 24h TTL
 * - Lazy cleanup: pending > 24h → cancel provisioned cost, add worst-case actual, mark expired
 */
async function findCachedMatch(
  firstName: string,
  lastName: string,
  organizationDomain: string
): Promise<{ record: typeof apolloPeopleEnrichments.$inferSelect; negative: boolean } | null> {
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

  const nameFilter = and(
    sql`LOWER(${apolloPeopleEnrichments.firstName}) = LOWER(${firstName})`,
    sql`LOWER(${apolloPeopleEnrichments.lastName}) = LOWER(${lastName})`,
    sql`LOWER(${apolloPeopleEnrichments.organizationDomain}) = LOWER(${organizationDomain})`,
  );

  // Positive cache: has email, 12-month TTL
  const [positive] = await db
    .select()
    .from(apolloPeopleEnrichments)
    .where(
      and(
        nameFilter,
        isNotNull(apolloPeopleEnrichments.email),
        gt(apolloPeopleEnrichments.createdAt, twelveMonthsAgo)
      )
    )
    .orderBy(desc(apolloPeopleEnrichments.createdAt))
    .limit(1);

  if (positive) return { record: positive, negative: false };

  // Negative cache: no email available
  // Case A: not pending + < 24h old -> we tried, no email
  // Case B: pending + > 24h old -> webhook never arrived, give up
  const twentyFourHoursAgo = new Date();
  twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);
  const twentyFourHoursAgoISO = twentyFourHoursAgo.toISOString();

  const [negative] = await db
    .select()
    .from(apolloPeopleEnrichments)
    .where(
      and(
        nameFilter,
        sql`${apolloPeopleEnrichments.email} IS NULL`,
        sql`(
          (COALESCE(${apolloPeopleEnrichments.waterfallStatus}, '') NOT IN ('pending') AND ${apolloPeopleEnrichments.createdAt} > ${twentyFourHoursAgoISO})
          OR
          (${apolloPeopleEnrichments.waterfallStatus} = 'pending' AND ${apolloPeopleEnrichments.createdAt} <= ${twentyFourHoursAgoISO})
        )`
      )
    )
    .orderBy(desc(apolloPeopleEnrichments.createdAt))
    .limit(1);

  if (negative) {
    // Lazy cleanup: pending > 24h → cancel provisioned cost, add worst-case actual, mark expired
    if (negative.waterfallStatus === "pending") {
      console.error(`[Apollo Service] Waterfall TTL expired: enrichment ${negative.id} still pending after 24h (waterfallRequestId=${negative.waterfallRequestId})`);

      const cleanupIdentity: IdentityHeaders = {
        orgId: negative.orgId,
        brandId: negative.brandIds?.join(","),
        campaignId: negative.campaignId,
      };

      // Cancel provisioned cost + add worst-case actual
      if (negative.provisionedCostId && negative.enrichmentRunId) {
        updateCostStatus(negative.enrichmentRunId, negative.provisionedCostId, "cancelled", cleanupIdentity).catch((err) => {
          console.error("[Apollo Service] Failed to cancel expired provisioned cost:", err);
        });
        addCosts(negative.enrichmentRunId, [{ costName: "apollo-credit", costSource: (negative.keySource as "platform" | "org") ?? "platform", quantity: WATERFALL_MAX_CREDITS, status: "actual" }], cleanupIdentity).catch((err) => {
          console.error("[Apollo Service] Failed to add worst-case actual cost:", err);
        });
      }

      // Emit trace event
      if (negative.enrichmentRunId) {
        traceEvent(negative.enrichmentRunId, { service: "apollo-service", event: "waterfall-expired", detail: `enrichmentId=${negative.id}, waterfallRequestId=${negative.waterfallRequestId}, worstCaseCredits=${WATERFALL_MAX_CREDITS}`, level: "error", data: { enrichmentId: negative.id, waterfallRequestId: negative.waterfallRequestId, worstCaseCredits: WATERFALL_MAX_CREDITS } }, { "x-org-id": negative.orgId }).catch(() => {});
      }

      // Mark as expired in DB
      db.update(apolloPeopleEnrichments)
        .set({ waterfallStatus: "expired" })
        .where(eq(apolloPeopleEnrichments.id, negative.id))
        .catch((err) => {
          console.error("[Apollo Service] Failed to mark waterfall as expired:", err);
        });
    }
    return { record: negative, negative: true };
  }

  return null;
}

/**
 * Poll the DB for a waterfall email result.
 * Returns:
 * - { record, resolved: true } if webhook arrived (with or without email)
 * - { record: null, resolved: false } if poll timed out
 */
async function pollForWaterfallEmail(
  enrichmentId: string,
  timeoutMs: number = getWaterfallPollTimeoutMs(),
  intervalMs: number = getWaterfallPollIntervalMs(),
): Promise<{ record: typeof apolloPeopleEnrichments.$inferSelect | null; resolved: boolean }> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));

    const [record] = await db
      .select()
      .from(apolloPeopleEnrichments)
      .where(eq(apolloPeopleEnrichments.id, enrichmentId))
      .limit(1);

    if (!record) return { record: null, resolved: false };

    // Webhook arrived with email
    if (record.email) return { record, resolved: true };

    // Webhook arrived but found nothing
    if (record.waterfallStatus === "failed" || record.waterfallStatus === "completed") return { record: null, resolved: true };
  }

  // Timed out
  return { record: null, resolved: false };
}

/**
 * POST /match - Match a single person by name + domain
 */
router.post("/match", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { runId, brandId, brandIds, campaignId, featureSlug, workflowSlug } = req;
    if (!runId || !brandIds?.length || !campaignId) {
      return res.status(400).json({ error: "x-run-id, x-brand-id, and x-campaign-id headers required" });
    }
    const identity: IdentityHeaders = { orgId: req.orgId!, userId: req.userId, brandId, campaignId, featureSlug, workflowSlug };
    const tracking = { brandId, campaignId, featureSlug, workflowSlug };

    const parsed = MatchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    }
    const { firstName, lastName, organizationDomain } = parsed.data;

    traceEvent(runId, { service: "apollo-service", event: "match-start", detail: `name=${firstName} ${lastName}, domain=${organizationDomain}` }, req.headers).catch(() => {});

    // Check cache first
    const cacheHit = await findCachedMatch(firstName, lastName, organizationDomain);

    if (cacheHit) {
      traceEvent(runId, { service: "apollo-service", event: "match-cache-hit", detail: `negative=${cacheHit.negative}` }, req.headers).catch(() => {});
      const cachedRun = await createRun({
        orgId: req.orgId!,
        userId: req.userId,
        brandId,
        campaignId,
        serviceName: "apollo-service",
        taskName: "person-match",
        parentRunId: runId,
        workflowSlug,
      });
      await updateRun(cachedRun.id, "completed", identity);

      return res.json({
        enrichmentId: null,
        person: cacheHit.negative ? null : transformCachedEnrichment(cacheHit.record.apolloPersonId ?? "", cacheHit.record),
        cached: true,
      });
    }

    // Cache miss: call Apollo API
    const { key: apolloApiKey, keySource } = await decryptKey(req.orgId!, req.userId!, "apollo", { callerMethod: "POST", callerPath: "/match" }, tracking);
    assertKeySource(keySource);

    if (keySource === "platform") {
      const auth = await authorizeCredit({
        items: [{ costName: "apollo-credit", quantity: 1 }],
        description: "apollo-credit",
        orgId: req.orgId!,
        userId: req.userId!,
        runId,
        brandId,
        campaignId,
        featureSlug,
        workflowSlug,
      });
      if (!auth.sufficient) {
        return res.status(402).json({
          error: "Insufficient credits",
          balance_cents: auth.balance_cents,
          required_cents: auth.required_cents,
        });
      }
    }

    const webhookUrl = buildWaterfallWebhookUrl();
    const result = await matchPersonByName(apolloApiKey, firstName, lastName, organizationDomain, webhookUrl);
    const person = result.person;
    const waterfallAccepted = result.waterfall?.status === "accepted";
    const waterfallRequestId = result.request_id ? String(result.request_id) : null;

    const matchRun = await createRun({
      orgId: req.orgId!,
      userId: req.userId,
      brandId,
      campaignId,
      featureSlug,
      serviceName: "apollo-service",
      taskName: "person-match",
      parentRunId: runId,
      workflowSlug,
    });

    let enrichmentId: string | null = null;
    let provisionedCostId: string | null = null;

    if (person) {
      // If waterfall will be used, provision max credits upfront
      if (!person.email && waterfallAccepted) {
        const { costs } = await addCosts(matchRun.id, [{ costName: "apollo-credit", costSource: keySource, quantity: WATERFALL_MAX_CREDITS, status: "provisioned" }], identity);
        provisionedCostId = costs[0]?.id ?? null;
      }

      const [enrichment] = await db.insert(apolloPeopleEnrichments).values({
        orgId: req.orgId!,
        runId,
        brandIds,
        campaignId,
        featureSlug,
        workflowSlug,
        ...toEnrichmentDbValues(person),
        enrichmentRunId: matchRun.id,
        keySource,
        waterfallRequestId,
        waterfallStatus: !person.email && waterfallAccepted ? "pending" : null,
        provisionedCostId,
      }).returning();

      enrichmentId = enrichment.id;

      if (person.email) {
        // Email found immediately — charge 1 credit actual
        await addCosts(matchRun.id, [{ costName: "apollo-credit", costSource: keySource, quantity: 1 }], identity);
      } else if (waterfallAccepted && enrichmentId) {
        // Waterfall accepted — poll for email synchronously
        traceEvent(runId, { service: "apollo-service", event: "waterfall-poll-start", detail: `enrichmentId=${enrichmentId}, waterfallRequestId=${waterfallRequestId}` }, req.headers).catch(() => {});

        const pollResult = await pollForWaterfallEmail(enrichmentId);

        if (pollResult.resolved) {
          if (pollResult.record?.email) {
            // Waterfall found email during poll
            traceEvent(runId, { service: "apollo-service", event: "waterfall-poll-success", detail: `email found via waterfall` }, req.headers).catch(() => {});

            // Cancel provisioned, actual cost will be added by webhook handler
            if (provisionedCostId) {
              await updateCostStatus(matchRun.id, provisionedCostId, "cancelled", identity);
            }

            await updateRun(matchRun.id, "completed", identity);

            const transformed = transformCachedEnrichment(pollResult.record.apolloPersonId ?? person.id, pollResult.record);
            return res.json({ enrichmentId, person: transformed, cached: false });
          }

          // Waterfall completed but found nothing — this is a valid result, not a timeout
          if (provisionedCostId) {
            await updateCostStatus(matchRun.id, provisionedCostId, "cancelled", identity);
          }
          await updateRun(matchRun.id, "completed", identity);

          traceEvent(runId, { service: "apollo-service", event: "match-done", detail: `enrichmentId=${enrichmentId}, hasEmail=false, waterfallResolved=true` }, req.headers).catch(() => {});

          return res.json({ enrichmentId, person: null, cached: false });
        }

        // Timeout — waterfall didn't resolve in time
        console.error(`[Apollo Service] Waterfall polling timeout: enrichment ${enrichmentId} (waterfallRequestId=${waterfallRequestId})`);
        traceEvent(runId, { service: "apollo-service", event: "waterfall-poll-timeout", detail: `enrichmentId=${enrichmentId}, waterfallRequestId=${waterfallRequestId}`, level: "error" }, req.headers).catch(() => {});

        // Mark run as FAILED — cost stays provisioned (webhook may still arrive)
        await updateRun(matchRun.id, "failed", identity);

        return res.status(504).json({
          error: "Waterfall email enrichment timeout — webhook did not arrive within 60s",
          enrichmentId,
        });
      }
    } else {
      // Store negative cache record so we don't re-query Apollo for 24h
      await db.insert(apolloPeopleEnrichments).values({
        orgId: req.orgId!,
        runId,
        brandIds,
        campaignId,
        featureSlug,
        workflowSlug,
        firstName,
        lastName,
        organizationDomain,
        enrichmentRunId: matchRun.id,
        keySource,
      });
    }

    await updateRun(matchRun.id, "completed", identity);

    const transformed = person ? transformApolloPerson(person) : null;

    traceEvent(runId, { service: "apollo-service", event: "match-done", detail: `enrichmentId=${enrichmentId}, hasEmail=${!!person?.email}, waterfallAccepted=${waterfallAccepted}`, data: { enrichmentId, hasEmail: !!person?.email } }, req.headers).catch(() => {});

    res.json({ enrichmentId, person: transformed, cached: false });
  } catch (error) {
    console.error("[Apollo Service][POST /match] ERROR:", error);
    if (req.runId) {
      traceEvent(req.runId, { service: "apollo-service", event: "match-error", detail: error instanceof Error ? error.message : "Unknown error", level: "error" }, req.headers).catch(() => {});
    }
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

export default router;
