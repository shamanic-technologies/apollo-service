import { Router } from "express";
import { and, gt, eq, isNotNull, desc, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { apolloPeopleEnrichments } from "../db/schema.js";
import { serviceAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { matchPersonByName, buildWaterfallWebhookUrl } from "../lib/apollo-client.js";
import { decryptKey } from "../lib/keys-client.js";
import { createRun, updateRun, addCosts, type IdentityHeaders } from "../lib/runs-client.js";
import { authorizeCredit } from "../lib/billing-client.js";
import { transformApolloPerson, toEnrichmentDbValues, transformCachedEnrichment } from "../lib/transform.js";
import { MatchRequestSchema } from "../schemas.js";
import { traceEvent } from "../lib/trace-event.js";
import { assertKeySource } from "../lib/validators.js";
// Waterfall disabled 2026-05-28 — see src/lib/waterfall.ts header for revive.
// import {
//   WATERFALL_MAX_CREDITS,
//   pollForWaterfallEmail,
//   provisionWaterfallCost,
//   expireStalePendingWaterfall,
// } from "../lib/waterfall.js";

const router = Router();

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
    // Waterfall disabled 2026-05-28 — no more lazy cleanup of pending rows.
    // if (negative.waterfallStatus === "pending") {
    //   await expireStalePendingWaterfall(negative);
    // }
    return { record: negative, negative: true };
  }

  return null;
}

/**
 * POST /match - Match a single person by name + domain
 */
router.post("/match", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { runId, brandIds, campaignId, featureSlug, workflowSlug } = req;
    if (!runId || !brandIds?.length || !campaignId) {
      return res.status(400).json({ type: "validation", error: "x-run-id, x-brand-id, and x-campaign-id headers required" });
    }
    const identity: IdentityHeaders = { orgId: req.orgId!, userId: req.userId, brandIds, campaignId, featureSlug, workflowSlug };
    const tracking = { brandIds, campaignId, featureSlug, workflowSlug };

    const parsed = MatchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ type: "validation", error: "Invalid request", details: parsed.error.flatten() });
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
        brandIds,
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

    // Waterfall disabled 2026-05-28 — authorize the direct Apollo cost (1
    // credit per email). Previously authorized WATERFALL_MAX_CREDITS=20.
    if (keySource === "platform") {
      const auth = await authorizeCredit({
        items: [{ costName: "apollo-credit", quantity: 1 }],
        description: "apollo-credit",
        orgId: req.orgId!,
        userId: req.userId!,
        runId,
        brandIds,
        campaignId,
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

    const webhookUrl = buildWaterfallWebhookUrl();
    const result = await matchPersonByName(apolloApiKey, firstName, lastName, organizationDomain, webhookUrl);
    const person = result.person;

    const matchRun = await createRun({
      orgId: req.orgId!,
      userId: req.userId,
      brandIds,
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
      }).returning();

      enrichmentId = enrichment.id;

      if (person.email) {
        // Email found immediately — charge 1 credit actual
        await addCosts(matchRun.id, [{ costName: "apollo-credit", costSource: keySource, quantity: 1 }], identity);
      }

      // Waterfall disabled 2026-05-28 — see src/lib/waterfall.ts revive notes.
      // Previously: if !person.email && waterfall.status==="accepted",
      // provision WATERFALL_MAX_CREDITS, poll up to 60s, return person on
      // resolved or 504 on timeout. Now no-op: callers see person:null when
      // Apollo returns no email.
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

    traceEvent(runId, { service: "apollo-service", event: "match-done", detail: `enrichmentId=${enrichmentId}, hasEmail=${!!person?.email}`, data: { enrichmentId, hasEmail: !!person?.email } }, req.headers).catch(() => {});

    res.json({ enrichmentId, person: transformed, cached: false });
  } catch (error) {
    console.error("[Apollo Service][POST /match] ERROR:", error);
    if (req.runId) {
      traceEvent(req.runId, { service: "apollo-service", event: "match-error", detail: error instanceof Error ? error.message : "Unknown error", level: "error" }, req.headers).catch(() => {});
    }
    res.status(500).json({ type: "internal", error: error instanceof Error ? error.message : "Internal server error" });
  }
});

export default router;
