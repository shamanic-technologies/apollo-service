import { Router } from "express";
import { eq, and, gt, isNotNull, desc, inArray, count, sum } from "drizzle-orm";
import { db } from "../db/index.js";
import { apolloPeopleSearches, apolloPeopleEnrichments, apolloSearchCursors } from "../db/schema.js";
import { serviceAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { searchPeople, enrichPerson, ApolloPerson } from "../lib/apollo-client.js";
import { getByokKey } from "../lib/keys-client.js";
import { createRun, updateRun, addCosts } from "../lib/runs-client.js";
import { transformApolloPerson, toEnrichmentDbValues, transformCachedEnrichment, toApolloSearchParams } from "../lib/transform.js";
import { SearchRequestSchema, SearchNextRequestSchema, EnrichRequestSchema, StatsRequestSchema } from "../schemas.js";

const router = Router();

/**
 * POST /search - Search for people via Apollo
 */
router.post("/search", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const parsed = SearchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    }
    const { runId, appId, brandId, campaignId, ...searchParams } = parsed.data;

    // Get Apollo API key from key-service
    const apolloApiKey = await getByokKey(req.clerkOrgId!, "apollo");

    // Call Apollo API
    const apolloParams = {
      ...toApolloSearchParams(searchParams),
      page: searchParams.page || 1,
      per_page: searchParams.perPage || 25,
    };

    // Create a child run in runs-service for this search
    const searchRun = await createRun({
      clerkOrgId: req.clerkOrgId!,
      appId: appId || "mcpfactory",
      brandId,
      campaignId,
      serviceName: "apollo-service",
      taskName: "people-search",
      parentRunId: runId,
    });

    const result = await searchPeople(apolloApiKey, apolloParams);

    // Get total entries (new API format has it at root level)
    const totalEntries = result.total_entries ?? result.pagination?.total_entries ?? 0;

    if (!result.people || result.people.length === 0) {
      console.warn("[Apollo Service][POST /search] ⚠ Apollo returned 0 people", {
        orgId: req.orgId,
        runId,
        apolloParams,
        totalEntries,
        rawResponseKeys: Object.keys(result),
      });
    }

    // Store search record
    const [search] = await db
      .insert(apolloPeopleSearches)
      .values({
        orgId: req.orgId!,
        runId,
        appId,
        brandId,
        campaignId,
        requestParams: apolloParams,
        peopleCount: result.people.length,
        totalEntries,
        responseRaw: result,
      })
      .returning();

    // Store search result records (no enrichment costs — those are tracked when POST /enrich is called)
    for (const person of result.people as ApolloPerson[]) {
      await db.insert(apolloPeopleEnrichments).values({
        orgId: req.orgId!,
        runId,
        searchId: search.id,
        appId,
        brandId,
        campaignId,
        ...toEnrichmentDbValues(person),
      });
    }

    // Track search cost and mark run as completed
    await addCosts(searchRun.id, [{ costName: "apollo-search-credit", quantity: 1 }]);
    await updateRun(searchRun.id, "completed");

    // Fill in cached emails for people without email
    const personIdsWithoutEmail = result.people
      .filter((p: ApolloPerson) => !p.email && p.id)
      .map((p: ApolloPerson) => p.id);

    const emailCache = new Map<string, { email: string; emailStatus: string | null }>();
    if (personIdsWithoutEmail.length > 0) {
      const twelveMonthsAgo = new Date();
      twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

      const cachedEnrichments = await db
        .select({
          apolloPersonId: apolloPeopleEnrichments.apolloPersonId,
          email: apolloPeopleEnrichments.email,
          emailStatus: apolloPeopleEnrichments.emailStatus,
        })
        .from(apolloPeopleEnrichments)
        .where(
          and(
            inArray(apolloPeopleEnrichments.apolloPersonId, personIdsWithoutEmail),
            isNotNull(apolloPeopleEnrichments.email),
            gt(apolloPeopleEnrichments.createdAt, twelveMonthsAgo)
          )
        );

      for (const row of cachedEnrichments) {
        if (row.apolloPersonId && row.email) {
          emailCache.set(row.apolloPersonId, { email: row.email, emailStatus: row.emailStatus });
        }
      }
    }

    // Transform to camelCase for worker consumption
    const transformedPeople = result.people.map((person: ApolloPerson) => {
      const cached = !person.email && person.id ? emailCache.get(person.id) : undefined;
      const transformed = transformApolloPerson(person);
      if (cached) {
        return { ...transformed, email: cached.email, emailStatus: cached.emailStatus };
      }
      return transformed;
    });

    res.json({
      searchId: search.id,
      peopleCount: result.people.length,
      totalEntries,
      people: transformedPeople,
      pagination: {
        page: apolloParams.page ?? 1,
        perPage: apolloParams.per_page ?? 25,
        totalEntries,
        totalPages: Math.ceil(totalEntries / (apolloParams.per_page ?? 25)),
      },
    });
  } catch (error) {
    console.error("[Apollo Service][POST /search] ERROR:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

/**
 * POST /enrich - Enrich a single person via Apollo to reveal their email
 */
router.post("/enrich", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const parsed = EnrichRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    }
    const { apolloPersonId, runId, appId, brandId, campaignId } = parsed.data;

    // Check cache: existing enrichment for this personId within 12 months
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

    const [cached] = await db
      .select()
      .from(apolloPeopleEnrichments)
      .where(
        and(
          eq(apolloPeopleEnrichments.apolloPersonId, apolloPersonId),
          isNotNull(apolloPeopleEnrichments.email),
          gt(apolloPeopleEnrichments.createdAt, twelveMonthsAgo)
        )
      )
      .orderBy(desc(apolloPeopleEnrichments.createdAt))
      .limit(1);

    if (cached) {
      return res.json({
        enrichmentId: null,
        person: transformCachedEnrichment(apolloPersonId, cached),
      });
    }

    const apolloApiKey = await getByokKey(req.clerkOrgId!, "apollo");
    const result = await enrichPerson(apolloApiKey, apolloPersonId);
    const person = result.person;

    // Store enrichment record and track costs
    let enrichmentId: string | null = null;
    if (person) {
      const [enrichment] = await db.insert(apolloPeopleEnrichments).values({
        orgId: req.orgId!,
        runId,
        appId,
        brandId,
        campaignId,
        ...toEnrichmentDbValues(person),
      }).returning();

      enrichmentId = enrichment.id;

      // Track cost in runs-service
      const enrichRun = await createRun({
        clerkOrgId: req.clerkOrgId!,
        appId: appId || "mcpfactory",
        brandId,
        campaignId,
        serviceName: "apollo-service",
        taskName: "enrichment",
        parentRunId: runId,
      });

      await db.update(apolloPeopleEnrichments)
        .set({ enrichmentRunId: enrichRun.id })
        .where(eq(apolloPeopleEnrichments.id, enrichment.id));

      await addCosts(enrichRun.id, [{ costName: "apollo-enrichment-credit", quantity: 1 }]);
      await updateRun(enrichRun.id, "completed");
    }

    const transformed = person ? transformApolloPerson(person) : null;

    res.json({ enrichmentId, person: transformed });
  } catch (error) {
    console.error("[Apollo Service][POST /enrich] ERROR:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

/**
 * POST /search/next - Server-managed pagination for campaign searches.
 * First call with searchParams starts a new search cursor.
 * Subsequent calls return the next batch of unseen people.
 */
router.post("/search/next", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const parsed = SearchNextRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    }
    const { campaignId, brandId, appId, searchParams, runId } = parsed.data;

    // Get Apollo API key
    const apolloApiKey = await getByokKey(req.clerkOrgId!, "apollo");

    // Look up existing cursor for this campaign
    const [existingCursor] = await db
      .select()
      .from(apolloSearchCursors)
      .where(
        and(
          eq(apolloSearchCursors.orgId, req.orgId!),
          eq(apolloSearchCursors.campaignId, campaignId)
        )
      )
      .limit(1);

    // Determine search params and cursor state
    let cursorSearchParams: Record<string, unknown>;
    let currentPage: number;
    let isExhausted = false;
    let cursorId: string | undefined = existingCursor?.id;

    if (searchParams) {
      const paramsJson = JSON.stringify(searchParams);

      if (!existingCursor) {
        // Create new cursor
        const [newCursor] = await db.insert(apolloSearchCursors).values({
          orgId: req.orgId!,
          campaignId,
          appId,
          brandId,
          searchParams: searchParams as Record<string, unknown>,
          currentPage: 1,
          totalEntries: 0,
          exhausted: false,
        }).returning();
        cursorId = newCursor.id;
        cursorSearchParams = searchParams as Record<string, unknown>;
        currentPage = 1;
      } else if (JSON.stringify(existingCursor.searchParams) !== paramsJson) {
        // Params changed — reset cursor
        await db
          .update(apolloSearchCursors)
          .set({
            searchParams: searchParams as Record<string, unknown>,
            currentPage: 1,
            totalEntries: 0,
            exhausted: false,
            updatedAt: new Date(),
          })
          .where(eq(apolloSearchCursors.id, existingCursor.id));
        cursorSearchParams = searchParams as Record<string, unknown>;
        currentPage = 1;
      } else {
        // Same params — use existing cursor position
        cursorSearchParams = existingCursor.searchParams as Record<string, unknown>;
        currentPage = existingCursor.currentPage;
        isExhausted = existingCursor.exhausted;
      }
    } else {
      // No searchParams — must have existing cursor
      if (!existingCursor) {
        return res.status(400).json({
          error: "No search cursor found for this campaign. Provide searchParams to start a new search.",
        });
      }
      cursorSearchParams = existingCursor.searchParams as Record<string, unknown>;
      currentPage = existingCursor.currentPage;
      isExhausted = existingCursor.exhausted;
    }

    // If already exhausted, return immediately
    if (isExhausted) {
      return res.json({
        people: [],
        done: true,
        totalEntries: existingCursor?.totalEntries ?? 0,
      });
    }

    // Fetch current page from Apollo
    const apolloParams = {
      ...toApolloSearchParams(cursorSearchParams),
      page: currentPage,
      per_page: 25,
    };
    const result = await searchPeople(apolloApiKey, apolloParams);
    const totalEntries = result.total_entries ?? result.pagination?.total_entries ?? 0;
    const people = result.people ?? [];

    // Advance cursor
    const nextPage = currentPage + 1;
    const totalPages = Math.ceil(totalEntries / 25);
    const done = people.length === 0 || nextPage > totalPages || nextPage > 500;

    if (cursorId) {
      await db
        .update(apolloSearchCursors)
        .set({
          currentPage: nextPage,
          totalEntries,
          exhausted: done,
          updatedAt: new Date(),
        })
        .where(eq(apolloSearchCursors.id, cursorId));
    }

    // Store search record (audit trail) and track costs
    const searchRun = await createRun({
      clerkOrgId: req.clerkOrgId!,
      appId: appId || "mcpfactory",
      brandId,
      campaignId,
      serviceName: "apollo-service",
      taskName: "people-search-next",
      parentRunId: runId,
    });

    await db.insert(apolloPeopleSearches).values({
      orgId: req.orgId!,
      runId,
      appId,
      brandId,
      campaignId,
      requestParams: apolloParams,
      peopleCount: people.length,
      totalEntries,
      responseRaw: result,
    });

    await addCosts(searchRun.id, [{ costName: "apollo-search-credit", quantity: 1 }]);
    await updateRun(searchRun.id, "completed");

    // Transform and respond
    const transformedPeople = people.map((person: ApolloPerson) =>
      transformApolloPerson(person)
    );

    res.json({
      people: transformedPeople,
      done,
      totalEntries,
    });
  } catch (error) {
    console.error("[Apollo Service][POST /search/next] ERROR:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

/**
 * GET /searches/:runId - Get all searches for a run
 */
router.get("/searches/:runId", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { runId } = req.params;

    const searches = await db.query.apolloPeopleSearches.findMany({
      where: (searches, { eq, and }) =>
        and(
          eq(searches.runId, runId),
          eq(searches.orgId, req.orgId!)
        ),
    });

    res.json({ searches });
  } catch (error) {
    console.error("[Apollo Service][GET /searches] ERROR:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /enrichments/:runId - Get all enrichments for a run
 */
router.get("/enrichments/:runId", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { runId } = req.params;

    const enrichments = await db.query.apolloPeopleEnrichments.findMany({
      where: (enrichments, { eq, and }) =>
        and(
          eq(enrichments.runId, runId),
          eq(enrichments.orgId, req.orgId!)
        ),
    });

    if (enrichments.length === 0) {
      console.warn("[Apollo Service][GET /enrichments] ⚠ returned 0 enrichments", {
        runId,
        orgId: req.orgId,
        hint: "Check: was POST /search called with this runId? Was x-clerk-org-id the same?",
      });
    }

    res.json({ enrichments });
  } catch (error) {
    console.error("[Apollo Service][GET /enrichments] ERROR:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /stats - Get aggregated stats with optional filters
 * Body: { runIds?: string[], appId?: string, brandId?: string, campaignId?: string }
 * orgId is always applied from auth. All body filters are optional.
 */
router.post("/stats", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const parsed = StatsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    }
    const { runIds, appId, brandId, campaignId } = parsed.data;

    // Build dynamic where conditions for enrichments
    const enrichConditions = [eq(apolloPeopleEnrichments.orgId, req.orgId!)];
    if (runIds?.length) enrichConditions.push(inArray(apolloPeopleEnrichments.runId, runIds));
    if (appId) enrichConditions.push(eq(apolloPeopleEnrichments.appId, appId));
    if (brandId) enrichConditions.push(eq(apolloPeopleEnrichments.brandId, brandId));
    if (campaignId) enrichConditions.push(eq(apolloPeopleEnrichments.campaignId, campaignId));

    // Build dynamic where conditions for searches
    const searchConditions = [eq(apolloPeopleSearches.orgId, req.orgId!)];
    if (runIds?.length) searchConditions.push(inArray(apolloPeopleSearches.runId, runIds));
    if (appId) searchConditions.push(eq(apolloPeopleSearches.appId, appId));
    if (brandId) searchConditions.push(eq(apolloPeopleSearches.brandId, brandId));
    if (campaignId) searchConditions.push(eq(apolloPeopleSearches.campaignId, campaignId));

    // Use SQL COUNT/SUM instead of fetching all rows into memory
    const [enrichmentStats] = await db
      .select({ enrichedLeadsCount: count() })
      .from(apolloPeopleEnrichments)
      .where(and(...enrichConditions));

    const [searchStats] = await db
      .select({
        searchCount: count(),
        fetchedPeopleCount: sum(apolloPeopleSearches.peopleCount),
        totalMatchingPeople: sum(apolloPeopleSearches.totalEntries),
      })
      .from(apolloPeopleSearches)
      .where(and(...searchConditions));

    const stats = {
      enrichedLeadsCount: enrichmentStats.enrichedLeadsCount,
      searchCount: searchStats.searchCount,
      fetchedPeopleCount: Number(searchStats.fetchedPeopleCount) || 0,
      totalMatchingPeople: Number(searchStats.totalMatchingPeople) || 0,
    };

    // Only warn when searches exist but enrichments don't — that's the actual anomaly
    if (stats.searchCount > 0 && stats.enrichedLeadsCount === 0) {
      console.warn("[Apollo Service][POST /stats] searches found but 0 leads", {
        orgId: req.orgId,
        appId,
        brandId,
        campaignId,
        runIds: runIds?.slice(0, 5),
        searchCount: stats.searchCount,
      });
    }

    res.json({ stats });
  } catch (error) {
    console.error("[Apollo Service][POST /stats] ERROR:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
