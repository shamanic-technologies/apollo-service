import { Router } from "express";
import { and, gt, isNotNull, desc, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { apolloPeopleEnrichments } from "../db/schema.js";
import { serviceAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { matchPersonByName, bulkMatchPeopleByName, buildWaterfallWebhookUrl } from "../lib/apollo-client.js";
import { decryptKey } from "../lib/keys-client.js";
import { createRun, updateRun, addCosts, type IdentityHeaders } from "../lib/runs-client.js";
import { authorizeCredit } from "../lib/billing-client.js";
import { transformApolloPerson, toEnrichmentDbValues, transformCachedEnrichment } from "../lib/transform.js";
import { MatchRequestSchema, MatchBulkRequestSchema } from "../schemas.js";
import { traceEvent } from "../lib/trace-event.js";

const router = Router();

/**
 * Look up a cached enrichment by firstName + lastName + organizationDomain.
 * Case-insensitive.
 * - Positive cache (has email): 12-month TTL
 * - Negative cache (no email, waterfall not pending): 24h TTL
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
  // Case A: not pending + < 24h old → we tried, no email
  // Case B: pending + > 24h old → webhook never arrived, give up
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
          (COALESCE(${apolloPeopleEnrichments.waterfallStatus}, '') != 'pending' AND ${apolloPeopleEnrichments.createdAt} > ${twentyFourHoursAgoISO})
          OR
          (${apolloPeopleEnrichments.waterfallStatus} = 'pending' AND ${apolloPeopleEnrichments.createdAt} <= ${twentyFourHoursAgoISO})
        )`
      )
    )
    .orderBy(desc(apolloPeopleEnrichments.createdAt))
    .limit(1);

  if (negative) {
    if (negative.waterfallStatus === "pending") {
      console.error(`[Apollo Service] Waterfall TTL expired: enrichment ${negative.id} still pending after 24h (waterfallRequestId=${negative.waterfallRequestId})`);
    }
    return { record: negative, negative: true };
  }

  return null;
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

    if (person) {
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
      }).returning();

      enrichmentId = enrichment.id;

      if (person.email) {
        await addCosts(matchRun.id, [{ costName: "apollo-credit", costSource: keySource, quantity: 1 }], identity);
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

/**
 * POST /match/bulk - Bulk match people by name + domain.
 * Single run for the whole batch. Each item cached independently.
 */
router.post("/match/bulk", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { runId, brandId, brandIds, campaignId, featureSlug, workflowSlug } = req;
    if (!runId || !brandIds?.length || !campaignId) {
      return res.status(400).json({ error: "x-run-id, x-brand-id, and x-campaign-id headers required" });
    }
    const identity: IdentityHeaders = { orgId: req.orgId!, userId: req.userId, brandId, campaignId, featureSlug, workflowSlug };
    const tracking = { brandId, campaignId, featureSlug, workflowSlug };

    const parsed = MatchBulkRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    }
    const { items } = parsed.data;

    traceEvent(runId, { service: "apollo-service", event: "match-bulk-start", detail: `itemCount=${items.length}, campaignId=${campaignId}`, data: { itemCount: items.length } }, req.headers).catch(() => {});

    const batchRun = await createRun({
      orgId: req.orgId!,
      userId: req.userId,
      brandId,
      campaignId,
      featureSlug,
      serviceName: "apollo-service",
      taskName: "person-match-bulk",
      parentRunId: runId,
      workflowSlug,
    });

    // Check cache for each item
    const cacheHits = await Promise.all(
      items.map((item) => findCachedMatch(item.firstName, item.lastName, item.organizationDomain))
    );

    // Identify cache misses
    const missIndices: number[] = [];
    for (let i = 0; i < items.length; i++) {
      if (!cacheHits[i]) {
        missIndices.push(i);
      }
    }

    // Call Apollo bulk API for all misses in one request
    let apolloResults: (import("../lib/apollo-client.js").ApolloPerson | null)[] = [];
    let keySource: "org" | "platform" = "platform";
    let bulkWaterfallAccepted = false;
    let bulkWaterfallRequestId: string | null = null;
    if (missIndices.length > 0) {
      const { key: apolloApiKey, keySource: ks } = await decryptKey(req.orgId!, req.userId!, "apollo", { callerMethod: "POST", callerPath: "/match/bulk" }, tracking);
      keySource = ks;

      if (keySource === "platform") {
        const auth = await authorizeCredit({
          items: [{ costName: "apollo-credit", quantity: missIndices.length }],
          description: `apollo-credit x${missIndices.length}`,
          orgId: req.orgId!,
          userId: req.userId!,
          runId,
          brandId,
          campaignId,
          featureSlug,
          workflowSlug,
        });
        if (!auth.sufficient) {
          await updateRun(batchRun.id, "failed", identity);
          return res.status(402).json({
            error: "Insufficient credits",
            balance_cents: auth.balance_cents,
            required_cents: auth.required_cents,
          });
        }
      }

      const missItems = missIndices.map((i) => ({
        first_name: items[i].firstName,
        last_name: items[i].lastName,
        domain: items[i].organizationDomain,
      }));

      const webhookUrl = buildWaterfallWebhookUrl();
      const bulkResult = await bulkMatchPeopleByName(apolloApiKey, missItems, webhookUrl);
      apolloResults = bulkResult.matches;
      bulkWaterfallAccepted = bulkResult.waterfall?.status === "accepted";
      bulkWaterfallRequestId = bulkResult.request_id ? String(bulkResult.request_id) : null;
    }

    // Assemble results, store DB records, track costs
    let totalCreditsToCharge = 0;
    const results: Array<{
      enrichmentId: string | null;
      person: ReturnType<typeof transformApolloPerson> | ReturnType<typeof transformCachedEnrichment> | null;
      cached: boolean;
    }> = [];

    let apolloResultIdx = 0;
    for (let i = 0; i < items.length; i++) {
      const cacheHit = cacheHits[i];

      if (cacheHit) {
        results.push({
          enrichmentId: null,
          person: cacheHit.negative ? null : transformCachedEnrichment(cacheHit.record.apolloPersonId ?? "", cacheHit.record),
          cached: true,
        });
      } else {
        const person = apolloResults[apolloResultIdx] ?? null;
        apolloResultIdx++;

        let enrichmentId: string | null = null;

        if (person) {
          const [enrichment] = await db.insert(apolloPeopleEnrichments).values({
            orgId: req.orgId!,
            runId,
            brandIds,
            campaignId,
            featureSlug,
            workflowSlug,
            ...toEnrichmentDbValues(person),
            enrichmentRunId: batchRun.id,
            keySource,
            waterfallRequestId: bulkWaterfallRequestId,
            waterfallStatus: !person.email && bulkWaterfallAccepted ? "pending" : null,
          }).returning();

          enrichmentId = enrichment.id;

          if (person.email) {
            totalCreditsToCharge++;
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
            firstName: items[i].firstName,
            lastName: items[i].lastName,
            organizationDomain: items[i].organizationDomain,
            enrichmentRunId: batchRun.id,
            keySource,
          });
        }

        results.push({
          enrichmentId,
          person: person ? transformApolloPerson(person) : null,
          cached: false,
        });
      }
    }

    if (totalCreditsToCharge > 0) {
      await addCosts(batchRun.id, [{ costName: "apollo-credit", costSource: keySource, quantity: totalCreditsToCharge }], identity);
    }

    await updateRun(batchRun.id, "completed", identity);

    traceEvent(runId, { service: "apollo-service", event: "match-bulk-done", detail: `total=${items.length}, cacheHits=${items.length - missIndices.length}, misses=${missIndices.length}, creditsCharged=${totalCreditsToCharge}`, data: { total: items.length, cacheHits: items.length - missIndices.length, creditsCharged: totalCreditsToCharge } }, req.headers).catch(() => {});

    res.json({ results });
  } catch (error) {
    console.error("[Apollo Service][POST /match/bulk] ERROR:", error);
    if (req.runId) {
      traceEvent(req.runId, { service: "apollo-service", event: "match-bulk-error", detail: error instanceof Error ? error.message : "Unknown error", level: "error" }, req.headers).catch(() => {});
    }
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

export default router;
