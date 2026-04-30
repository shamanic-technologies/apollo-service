import { Router } from "express";
import { eq, and, gt, isNotNull, desc, inArray, count, sum, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { apolloPeopleSearches, apolloPeopleEnrichments, apolloSearchCursors } from "../db/schema.js";
import { serviceAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { searchPeople, enrichPerson, ApolloPerson, buildWaterfallWebhookUrl } from "../lib/apollo-client.js";
import { decryptKey } from "../lib/keys-client.js";
import { createRun, updateRun, addCosts, type IdentityHeaders } from "../lib/runs-client.js";
import { authorizeCredit } from "../lib/billing-client.js";
import { transformApolloPerson, toEnrichmentDbValues, transformCachedEnrichment, toApolloSearchParams } from "../lib/transform.js";
import { SearchRequestSchema, SearchNextRequestSchema, EnrichRequestSchema, StatsRequestSchema } from "../schemas.js";
import { deepEqual } from "../lib/deep-equal.js";
import { traceEvent } from "../lib/trace-event.js";
import {
  resolveWorkflowDynastySlugs,
  resolveFeatureDynastySlugs,
  fetchAllWorkflowDynasties,
  fetchAllFeatureDynasties,
  buildSlugToDynastyMap,
} from "../lib/dynasty-client.js";

const router = Router();

/**
 * POST /search - Search for people via Apollo
 */
router.post("/search", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { runId, brandId, brandIds, campaignId, featureSlug, workflowSlug } = req;
    if (!runId || !brandIds?.length || !campaignId) {
      return res.status(400).json({ error: "x-run-id, x-brand-id, and x-campaign-id headers required" });
    }
    const identity: IdentityHeaders = { orgId: req.orgId!, userId: req.userId, brandId, campaignId, featureSlug, workflowSlug };
    const tracking = { brandId, campaignId, featureSlug, workflowSlug };

    const parsed = SearchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    }
    const searchParams = parsed.data;

    traceEvent(runId, { service: "apollo-service", event: "search-start", detail: `page=${searchParams.page ?? 1}, perPage=${searchParams.perPage ?? 25}, campaignId=${campaignId}` }, req.headers).catch(() => {});

    // Get Apollo API key from key-service
    const { key: apolloApiKey, keySource } = await decryptKey(req.orgId!, req.userId!, "apollo", { callerMethod: "POST", callerPath: "/search" }, tracking);

    // Call Apollo API (search is free — no credits consumed)
    const apolloParams = {
      ...toApolloSearchParams(searchParams),
      page: searchParams.page || 1,
      per_page: searchParams.perPage || 25,
    };

    // Create a child run in runs-service for this search
    const searchRun = await createRun({
      orgId: req.orgId!,
      userId: req.userId,
      brandId,
      campaignId,
      featureSlug,
      serviceName: "apollo-service",
      taskName: "people-search",
      parentRunId: runId,
      workflowSlug,
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
    } else {
      console.log(`[Apollo Service][POST /search] Found ${result.people.length} people (${totalEntries} total) runId=${runId} campaignId=${campaignId}`);
    }

    // Store search record
    const [search] = await db
      .insert(apolloPeopleSearches)
      .values({
        orgId: req.orgId!,
        runId,
        brandIds,
        campaignId,
        featureSlug,
        workflowSlug,
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
        brandIds,
        campaignId,
        featureSlug,
        workflowSlug,
        ...toEnrichmentDbValues(person),
      });
    }

    // Search is free — no Apollo credits consumed. Just mark run as completed.
    await updateRun(searchRun.id, "completed", identity);

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

    traceEvent(runId, { service: "apollo-service", event: "search-done", detail: `peopleCount=${result.people.length}, totalEntries=${totalEntries}, searchId=${search.id}`, data: { searchId: search.id, peopleCount: result.people.length, totalEntries } }, req.headers).catch(() => {});

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
    if (req.runId) {
      traceEvent(req.runId, { service: "apollo-service", event: "search-error", detail: error instanceof Error ? error.message : "Unknown error", level: "error" }, req.headers).catch(() => {});
    }
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

/**
 * POST /enrich - Enrich a single person via Apollo to reveal their email
 */
router.post("/enrich", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { runId, brandId, brandIds, campaignId, featureSlug, workflowSlug } = req;
    if (!runId || !brandIds?.length || !campaignId) {
      return res.status(400).json({ error: "x-run-id, x-brand-id, and x-campaign-id headers required" });
    }
    const identity: IdentityHeaders = { orgId: req.orgId!, userId: req.userId, brandId, campaignId, featureSlug, workflowSlug };
    const tracking = { brandId, campaignId, featureSlug, workflowSlug };

    const parsed = EnrichRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    }
    const { apolloPersonId } = parsed.data;

    traceEvent(runId, { service: "apollo-service", event: "enrich-start", detail: `apolloPersonId=${apolloPersonId}` }, req.headers).catch(() => {});

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
      traceEvent(runId, { service: "apollo-service", event: "enrich-cache-hit", detail: `apolloPersonId=${apolloPersonId}` }, req.headers).catch(() => {});
      // Create a run for traceability but no costs (cache hit)
      const cachedRun = await createRun({
        orgId: req.orgId!,
        userId: req.userId,
        brandId,
        campaignId,
        serviceName: "apollo-service",
        taskName: "enrichment",
        parentRunId: runId,
        workflowSlug,
      });
      await updateRun(cachedRun.id, "completed", identity);

      return res.json({
        enrichmentId: null,
        person: transformCachedEnrichment(apolloPersonId, cached),
      });
    }

    const { key: apolloApiKey, keySource } = await decryptKey(req.orgId!, req.userId!, "apollo", { callerMethod: "POST", callerPath: "/enrich" }, tracking);

    // Authorize credit before executing paid operation (platform keys only)
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
    const result = await enrichPerson(apolloApiKey, apolloPersonId, webhookUrl);
    const person = result.person;
    const waterfallAccepted = result.waterfall?.status === "accepted";
    const waterfallRequestId = result.request_id ? String(result.request_id) : null;

    // Store enrichment record and track costs
    let enrichmentId: string | null = null;
    if (person) {
      // Track cost in runs-service
      const enrichRun = await createRun({
        orgId: req.orgId!,
        userId: req.userId,
        brandId,
        campaignId,
        serviceName: "apollo-service",
        taskName: "enrichment",
        parentRunId: runId,
        workflowSlug,
      });

      const [enrichment] = await db.insert(apolloPeopleEnrichments).values({
        orgId: req.orgId!,
        runId,
        brandIds,
        campaignId,
        featureSlug,
        workflowSlug,
        ...toEnrichmentDbValues(person),
        enrichmentRunId: enrichRun.id,
        keySource,
        waterfallRequestId,
        waterfallStatus: !person.email && waterfallAccepted ? "pending" : null,
      }).returning();

      enrichmentId = enrichment.id;

      if (person.email) {
        await addCosts(enrichRun.id, [{ costName: "apollo-credit", costSource: keySource, quantity: 1 }], identity);
      }
      await updateRun(enrichRun.id, "completed", identity);
    }

    const transformed = person ? transformApolloPerson(person) : null;

    traceEvent(runId, { service: "apollo-service", event: "enrich-done", detail: `enrichmentId=${enrichmentId}, hasEmail=${!!person?.email}, waterfallAccepted=${waterfallAccepted}`, data: { enrichmentId, hasEmail: !!person?.email } }, req.headers).catch(() => {});

    res.json({ enrichmentId, person: transformed });
  } catch (error) {
    console.error("[Apollo Service][POST /enrich] ERROR:", error);
    if (req.runId) {
      traceEvent(req.runId, { service: "apollo-service", event: "enrich-error", detail: error instanceof Error ? error.message : "Unknown error", level: "error" }, req.headers).catch(() => {});
    }
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
    const { runId, brandId, brandIds, campaignId, featureSlug, workflowSlug } = req;
    if (!runId || !brandIds?.length || !campaignId) {
      return res.status(400).json({ error: "x-run-id, x-brand-id, and x-campaign-id headers required" });
    }
    const identity: IdentityHeaders = { orgId: req.orgId!, userId: req.userId, brandId, campaignId, featureSlug, workflowSlug };
    const tracking = { brandId, campaignId, featureSlug, workflowSlug };

    const parsed = SearchNextRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    }
    const { searchParams } = parsed.data;

    traceEvent(runId, { service: "apollo-service", event: "search-next-start", detail: `campaignId=${campaignId}, hasSearchParams=${!!searchParams}` }, req.headers).catch(() => {});

    // Get Apollo API key
    const { key: apolloApiKey, keySource } = await decryptKey(req.orgId!, req.userId!, "apollo", { callerMethod: "POST", callerPath: "/search/next" }, tracking);

    // Search is free — no Apollo credits consumed.

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
      if (!existingCursor) {
        // Create new cursor
        const [newCursor] = await db.insert(apolloSearchCursors).values({
          orgId: req.orgId!,
          campaignId,
          brandIds,
          featureSlug,
          workflowSlug,
          searchParams: searchParams as Record<string, unknown>,
          currentPage: 1,
          totalEntries: 0,
          exhausted: false,
        }).returning();
        cursorId = newCursor.id;
        cursorSearchParams = searchParams as Record<string, unknown>;
        currentPage = 1;
      } else if (!deepEqual(existingCursor.searchParams, searchParams)) {
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

    if (people.length === 0) {
      console.warn(`[Apollo Service][POST /search/next] ⚠ Apollo returned 0 people page=${currentPage} campaignId=${campaignId} runId=${runId}`);
    } else {
      console.log(`[Apollo Service][POST /search/next] Found ${people.length} people page=${currentPage} (${totalEntries} total) campaignId=${campaignId} runId=${runId}`);
    }

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
      orgId: req.orgId!,
      userId: req.userId,
      brandId,
      campaignId,
      featureSlug,
      serviceName: "apollo-service",
      taskName: "people-search-next",
      parentRunId: runId,
      workflowSlug,
    });

    await db.insert(apolloPeopleSearches).values({
      orgId: req.orgId!,
      runId,
      brandIds,
      campaignId,
      featureSlug,
      workflowSlug,
      requestParams: apolloParams,
      peopleCount: people.length,
      totalEntries,
      responseRaw: result,
    });

    await updateRun(searchRun.id, "completed", identity);

    // Transform and respond
    const transformedPeople = people.map((person: ApolloPerson) =>
      transformApolloPerson(person)
    );

    traceEvent(runId, { service: "apollo-service", event: "search-next-done", detail: `page=${currentPage}, peopleCount=${people.length}, done=${done}, totalEntries=${totalEntries}`, data: { page: currentPage, peopleCount: people.length, done, totalEntries } }, req.headers).catch(() => {});

    res.json({
      people: transformedPeople,
      done,
      totalEntries,
    });
  } catch (error) {
    console.error("[Apollo Service][POST /search/next] ERROR:", error);
    if (req.runId) {
      traceEvent(req.runId, { service: "apollo-service", event: "search-next-error", detail: error instanceof Error ? error.message : "Unknown error", level: "error" }, req.headers).catch(() => {});
    }
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
        hint: "Check: was POST /search called with this runId? Was x-org-id the same?",
      });
    }

    res.json({ enrichments });
  } catch (error) {
    console.error("[Apollo Service][GET /enrichments] ERROR:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /stats - Get aggregated stats with optional filters and groupBy
 * Body: { runIds?, brandId?, campaignId?, workflowSlug?, featureSlug?,
 *         workflowDynastySlug?, featureDynastySlug?, groupBy? }
 * orgId is always applied from auth. All body filters are optional.
 */
router.post("/stats", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const parsed = StatsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    }
    const {
      runIds, brandId, campaignId,
      workflowSlug, featureSlug,
      workflowDynastySlug, featureDynastySlug,
      groupBy,
    } = parsed.data;

    // Resolve dynasty slugs to versioned slug lists
    let resolvedWorkflowSlugs: string[] | undefined;
    let resolvedFeatureSlugs: string[] | undefined;

    if (workflowDynastySlug) {
      resolvedWorkflowSlugs = await resolveWorkflowDynastySlugs(workflowDynastySlug);
      if (resolvedWorkflowSlugs.length === 0) {
        return res.json(groupBy ? { grouped: [] } : {
          stats: { enrichedLeadsCount: 0, searchCount: 0, fetchedPeopleCount: 0, totalMatchingPeople: 0 },
        });
      }
    }
    if (featureDynastySlug) {
      resolvedFeatureSlugs = await resolveFeatureDynastySlugs(featureDynastySlug);
      if (resolvedFeatureSlugs.length === 0) {
        return res.json(groupBy ? { grouped: [] } : {
          stats: { enrichedLeadsCount: 0, searchCount: 0, fetchedPeopleCount: 0, totalMatchingPeople: 0 },
        });
      }
    }

    // Helper to build conditions for a table
    const buildConditions = (table: typeof apolloPeopleEnrichments | typeof apolloPeopleSearches) => {
      const conditions = [eq(table.orgId, req.orgId!)];
      if (runIds?.length) conditions.push(inArray(table.runId, runIds));
      if (brandId) conditions.push(sql`${brandId} = ANY(${table.brandIds})`);
      if (campaignId) conditions.push(eq(table.campaignId, campaignId));
      // Dynasty slug takes priority over exact slug
      if (resolvedWorkflowSlugs && resolvedWorkflowSlugs.length > 0) {
        conditions.push(inArray(table.workflowSlug, resolvedWorkflowSlugs));
      } else if (workflowSlug) {
        conditions.push(eq(table.workflowSlug, workflowSlug));
      }
      if (resolvedFeatureSlugs && resolvedFeatureSlugs.length > 0) {
        conditions.push(inArray(table.featureSlug, resolvedFeatureSlugs));
      } else if (featureSlug) {
        conditions.push(eq(table.featureSlug, featureSlug));
      }
      return conditions;
    };

    // ── GroupBy path ──
    if (groupBy) {
      const isWorkflowGroup = groupBy === "workflowSlug" || groupBy === "workflowDynastySlug";
      const isDynastyGroup = groupBy === "workflowDynastySlug" || groupBy === "featureDynastySlug";
      const slugCol = isWorkflowGroup ? "workflowSlug" : "featureSlug";

      // Query enrichments grouped by slug
      const enrichRows = await db
        .select({
          slug: isWorkflowGroup ? apolloPeopleEnrichments.workflowSlug : apolloPeopleEnrichments.featureSlug,
          enrichedLeadsCount: count(),
        })
        .from(apolloPeopleEnrichments)
        .where(and(...buildConditions(apolloPeopleEnrichments)))
        .groupBy(isWorkflowGroup ? apolloPeopleEnrichments.workflowSlug : apolloPeopleEnrichments.featureSlug);

      // Query searches grouped by slug
      const searchRows = await db
        .select({
          slug: isWorkflowGroup ? apolloPeopleSearches.workflowSlug : apolloPeopleSearches.featureSlug,
          searchCount: count(),
          fetchedPeopleCount: sum(apolloPeopleSearches.peopleCount),
          totalMatchingPeople: sum(apolloPeopleSearches.totalEntries),
        })
        .from(apolloPeopleSearches)
        .where(and(...buildConditions(apolloPeopleSearches)))
        .groupBy(isWorkflowGroup ? apolloPeopleSearches.workflowSlug : apolloPeopleSearches.featureSlug);

      // Build dynasty reverse map if needed
      let dynastyMap: Map<string, string> | undefined;
      if (isDynastyGroup) {
        const dynasties = isWorkflowGroup
          ? await fetchAllWorkflowDynasties()
          : await fetchAllFeatureDynasties();
        dynastyMap = buildSlugToDynastyMap(dynasties);
      }

      const resolveKey = (slug: string | null): string => {
        if (!slug) return "__none__";
        if (dynastyMap) return dynastyMap.get(slug) ?? slug;
        return slug;
      };

      // Merge enrichment + search rows into grouped results
      const groupedMap = new Map<string, {
        enrichedLeadsCount: number;
        searchCount: number;
        fetchedPeopleCount: number;
        totalMatchingPeople: number;
      }>();

      const ensureGroup = (key: string) => {
        if (!groupedMap.has(key)) {
          groupedMap.set(key, { enrichedLeadsCount: 0, searchCount: 0, fetchedPeopleCount: 0, totalMatchingPeople: 0 });
        }
        return groupedMap.get(key)!;
      };

      for (const row of enrichRows) {
        const key = resolveKey(row.slug);
        ensureGroup(key).enrichedLeadsCount += row.enrichedLeadsCount;
      }
      for (const row of searchRows) {
        const key = resolveKey(row.slug);
        const g = ensureGroup(key);
        g.searchCount += row.searchCount;
        g.fetchedPeopleCount += Number(row.fetchedPeopleCount) || 0;
        g.totalMatchingPeople += Number(row.totalMatchingPeople) || 0;
      }

      const grouped = Array.from(groupedMap.entries()).map(([key, vals]) => ({ key, ...vals }));
      return res.json({ grouped });
    }

    // ── Flat (non-grouped) path ──
    const enrichConditions = buildConditions(apolloPeopleEnrichments);
    const searchConditions = buildConditions(apolloPeopleSearches);

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

    res.json({ stats });
  } catch (error) {
    console.error("[Apollo Service][POST /stats] ERROR:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
