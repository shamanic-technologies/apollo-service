import { Router } from "express";
import { and, gt, isNotNull, desc, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { apolloPeopleEnrichments } from "../db/schema.js";
import { serviceAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { matchPersonByName, bulkMatchPeopleByName } from "../lib/apollo-client.js";
import { getByokKey } from "../lib/keys-client.js";
import { createRun, updateRun, addCosts } from "../lib/runs-client.js";
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
    const parsed = MatchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    }
    const { firstName, lastName, organizationDomain, runId, appId, brandId, campaignId, workflowName } = parsed.data;

    // Check cache first
    const cached = await findCachedMatch(firstName, lastName, organizationDomain);

    if (cached) {
      const cachedRun = await createRun({
        clerkOrgId: req.clerkOrgId!,
        appId: appId || "mcpfactory",
        brandId,
        campaignId,
        serviceName: "apollo-service",
        taskName: "person-match",
        parentRunId: runId,
        workflowName,
      });
      await updateRun(cachedRun.id, "completed");

      return res.json({
        enrichmentId: null,
        person: transformCachedEnrichment(cached.apolloPersonId ?? "", cached),
        cached: true,
      });
    }

    // Cache miss: call Apollo API
    const apolloApiKey = await getByokKey(req.clerkOrgId!, "apollo");
    const result = await matchPersonByName(apolloApiKey, firstName, lastName, organizationDomain);
    const person = result.person;

    const matchRun = await createRun({
      clerkOrgId: req.clerkOrgId!,
      appId: appId || "mcpfactory",
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
        appId,
        brandId,
        campaignId,
        ...toEnrichmentDbValues(person),
        enrichmentRunId: matchRun.id,
      }).returning();

      enrichmentId = enrichment.id;

      if (person.email) {
        await addCosts(matchRun.id, [{ costName: "apollo-person-match-credit", quantity: 1 }]);
      }
    }

    await updateRun(matchRun.id, "completed");

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
    const parsed = MatchBulkRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    }
    const { items, runId, appId, brandId, campaignId, workflowName } = parsed.data;

    const batchRun = await createRun({
      clerkOrgId: req.clerkOrgId!,
      appId: appId || "mcpfactory",
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
    if (missIndices.length > 0) {
      const apolloApiKey = await getByokKey(req.clerkOrgId!, "apollo");
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
      const cached = cacheResults[i];

      if (cached) {
        results.push({
          enrichmentId: null,
          person: transformCachedEnrichment(cached.apolloPersonId ?? "", cached),
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
            appId,
            brandId,
            campaignId,
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
      await addCosts(batchRun.id, [{ costName: "apollo-person-match-credit", quantity: totalCreditsToCharge }]);
    }

    await updateRun(batchRun.id, "completed");

    res.json({ results });
  } catch (error) {
    console.error("[Apollo Service][POST /match/bulk] ERROR:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

export default router;
