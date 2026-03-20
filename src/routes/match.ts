import { Router } from "express";
import { and, gt, isNotNull, desc, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { apolloPeopleEnrichments } from "../db/schema.js";
import { serviceAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { matchPersonByName, bulkMatchPeopleByName } from "../lib/apollo-client.js";
import { decryptKey } from "../lib/keys-client.js";
import { createRun, updateRun, addCosts, type IdentityHeaders } from "../lib/runs-client.js";
import { authorizeCredit } from "../lib/billing-client.js";
import { transformApolloPerson, toEnrichmentDbValues, transformCachedEnrichment } from "../lib/transform.js";
import { MatchRequestSchema, MatchBulkRequestSchema } from "../schemas.js";

const router = Router();

/**
 * Look up a cached enrichment by firstName + lastName + organizationDomain.
 * Case-insensitive. Returns the most recent record within 12 months that has email.
 */
async function findCachedMatch(
  firstName: string,
  lastName: string,
  organizationDomain: string
) {
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

  const [cached] = await db
    .select()
    .from(apolloPeopleEnrichments)
    .where(
      and(
        sql`LOWER(${apolloPeopleEnrichments.firstName}) = LOWER(${firstName})`,
        sql`LOWER(${apolloPeopleEnrichments.lastName}) = LOWER(${lastName})`,
        sql`LOWER(${apolloPeopleEnrichments.organizationDomain}) = LOWER(${organizationDomain})`,
        isNotNull(apolloPeopleEnrichments.email),
        gt(apolloPeopleEnrichments.createdAt, twelveMonthsAgo)
      )
    )
    .orderBy(desc(apolloPeopleEnrichments.createdAt))
    .limit(1);

  return cached ?? null;
}

/**
 * POST /match - Match a single person by name + domain
 */
router.post("/match", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { runId, brandId, campaignId, workflowName } = req;
    if (!runId || !brandId || !campaignId) {
      return res.status(400).json({ error: "x-run-id, x-brand-id, and x-campaign-id headers required" });
    }
    const identity: IdentityHeaders = { orgId: req.orgId!, userId: req.userId, brandId, campaignId, workflowName };
    const tracking = { brandId, campaignId, workflowName };

    const parsed = MatchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    }
    const { firstName, lastName, organizationDomain } = parsed.data;

    // Check cache first
    const cached = await findCachedMatch(firstName, lastName, organizationDomain);

    if (cached) {
      const cachedRun = await createRun({
        orgId: req.orgId!,
        userId: req.userId,
        brandId,
        campaignId,
        serviceName: "apollo-service",
        taskName: "person-match",
        parentRunId: runId,
        workflowName,
      });
      await updateRun(cachedRun.id, "completed", identity);

      return res.json({
        enrichmentId: null,
        person: transformCachedEnrichment(cached.apolloPersonId ?? "", cached),
        cached: true,
      });
    }

    // Cache miss: call Apollo API
    const { key: apolloApiKey, keySource } = await decryptKey(req.orgId!, req.userId!, "apollo", { callerMethod: "POST", callerPath: "/match" }, tracking);

    if (keySource === "platform") {
      const auth = await authorizeCredit({
        requiredCents: 1,
        description: "apollo-person-match-credit",
        orgId: req.orgId!,
        userId: req.userId!,
        runId,
        brandId,
        campaignId,
        workflowName,
      });
      if (!auth.sufficient) {
        return res.status(402).json({
          error: "Insufficient credits",
          balance_cents: auth.balance_cents,
          required_cents: 1,
        });
      }
    }

    const result = await matchPersonByName(apolloApiKey, firstName, lastName, organizationDomain);
    const person = result.person;

    const matchRun = await createRun({
      orgId: req.orgId!,
      userId: req.userId,
      brandId,
      campaignId,
      serviceName: "apollo-service",
      taskName: "person-match",
      parentRunId: runId,
      workflowName,
    });

    let enrichmentId: string | null = null;

    if (person) {
      const [enrichment] = await db.insert(apolloPeopleEnrichments).values({
        orgId: req.orgId!,
        runId,
        brandId,
        campaignId,
        workflowName,
        ...toEnrichmentDbValues(person),
        enrichmentRunId: matchRun.id,
      }).returning();

      enrichmentId = enrichment.id;

      if (person.email) {
        await addCosts(matchRun.id, [{ costName: "apollo-person-match-credit", costSource: keySource, quantity: 1 }], identity);
      }
    }

    await updateRun(matchRun.id, "completed", identity);

    const transformed = person ? transformApolloPerson(person) : null;

    res.json({ enrichmentId, person: transformed, cached: false });
  } catch (error) {
    console.error("[Apollo Service][POST /match] ERROR:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

/**
 * POST /match/bulk - Bulk match people by name + domain.
 * Single run for the whole batch. Each item cached independently.
 */
router.post("/match/bulk", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { runId, brandId, campaignId, workflowName } = req;
    if (!runId || !brandId || !campaignId) {
      return res.status(400).json({ error: "x-run-id, x-brand-id, and x-campaign-id headers required" });
    }
    const identity: IdentityHeaders = { orgId: req.orgId!, userId: req.userId, brandId, campaignId, workflowName };
    const tracking = { brandId, campaignId, workflowName };

    const parsed = MatchBulkRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    }
    const { items } = parsed.data;

    const batchRun = await createRun({
      orgId: req.orgId!,
      userId: req.userId,
      brandId,
      campaignId,
      serviceName: "apollo-service",
      taskName: "person-match-bulk",
      parentRunId: runId,
      workflowName,
    });

    // Check cache for each item
    const cacheResults = await Promise.all(
      items.map((item) => findCachedMatch(item.firstName, item.lastName, item.organizationDomain))
    );

    // Identify cache misses
    const missIndices: number[] = [];
    for (let i = 0; i < items.length; i++) {
      if (!cacheResults[i]) {
        missIndices.push(i);
      }
    }

    // Call Apollo bulk API for all misses in one request
    let apolloResults: (import("../lib/apollo-client.js").ApolloPerson | null)[] = [];
    let keySource: "org" | "platform" = "platform";
    if (missIndices.length > 0) {
      const { key: apolloApiKey, keySource: ks } = await decryptKey(req.orgId!, req.userId!, "apollo", { callerMethod: "POST", callerPath: "/match/bulk" }, tracking);
      keySource = ks;

      if (keySource === "platform") {
        const auth = await authorizeCredit({
          requiredCents: missIndices.length,
          description: `apollo-person-match-credit x${missIndices.length}`,
          orgId: req.orgId!,
          userId: req.userId!,
          runId,
          brandId,
          campaignId,
          workflowName,
        });
        if (!auth.sufficient) {
          await updateRun(batchRun.id, "failed", identity);
          return res.status(402).json({
            error: "Insufficient credits",
            balance_cents: auth.balance_cents,
            required_cents: missIndices.length,
          });
        }
      }

      const missItems = missIndices.map((i) => ({
        first_name: items[i].firstName,
        last_name: items[i].lastName,
        domain: items[i].organizationDomain,
      }));

      const bulkResult = await bulkMatchPeopleByName(apolloApiKey, missItems);
      apolloResults = bulkResult.matches;
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
      const cachedItem = cacheResults[i];

      if (cachedItem) {
        results.push({
          enrichmentId: null,
          person: transformCachedEnrichment(cachedItem.apolloPersonId ?? "", cachedItem),
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
            brandId,
            campaignId,
            workflowName,
            ...toEnrichmentDbValues(person),
            enrichmentRunId: batchRun.id,
          }).returning();

          enrichmentId = enrichment.id;

          if (person.email) {
            totalCreditsToCharge++;
          }
        }

        results.push({
          enrichmentId,
          person: person ? transformApolloPerson(person) : null,
          cached: false,
        });
      }
    }

    if (totalCreditsToCharge > 0) {
      await addCosts(batchRun.id, [{ costName: "apollo-person-match-credit", costSource: keySource, quantity: totalCreditsToCharge }], identity);
    }

    await updateRun(batchRun.id, "completed", identity);

    res.json({ results });
  } catch (error) {
    console.error("[Apollo Service][POST /match/bulk] ERROR:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

export default router;
