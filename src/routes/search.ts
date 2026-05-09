import { Router } from "express";
import { eq, and, gt, isNotNull, desc, inArray, count, sum, sql, arrayOverlaps } from "drizzle-orm";
import { db } from "../db/index.js";
import { apolloPeopleSearches, apolloPeopleEnrichments, apolloSearchCursors } from "../db/schema.js";
import { serviceAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { searchPeople, enrichPerson, ApolloPerson, buildWaterfallWebhookUrl } from "../lib/apollo-client.js";
import { decryptKey } from "../lib/keys-client.js";
import { createRun, updateRun, addCosts, updateCostStatus, type IdentityHeaders } from "../lib/runs-client.js";
import { authorizeCredit } from "../lib/billing-client.js";
import { transformApolloPerson, toEnrichmentDbValues, transformCachedEnrichment, toApolloSearchParams } from "../lib/transform.js";
import { assertKeySource } from "../lib/validators.js";
import { SearchNextRequestSchema, SearchDryRunRequestSchema, EnrichRequestSchema, StatsRequestSchema, SearchFiltersSchema } from "../schemas.js";
import { buildFiltersPrompt, computeFiltersPromptVersion } from "../lib/filters-prompt.js";
import { deepEqual } from "../lib/deep-equal.js";
import { traceEvent } from "../lib/trace-event.js";
import {
  WATERFALL_MAX_CREDITS,
  pollForWaterfallEmail,
  provisionWaterfallCost,
  expireStalePendingWaterfall,
} from "../lib/waterfall.js";
import {
  resolveWorkflowDynastySlugs,
  resolveFeatureDynastySlugs,
  fetchAllWorkflowDynasties,
  fetchAllFeatureDynasties,
  buildSlugToDynastyMap,
} from "../lib/dynasty-client.js";

const router = Router();

const DEFAULT_PER_PAGE = 100;

// Compute the filters prompt once at module load. SearchFiltersSchema is
// static, so the prompt + hash never change between calls — fail-loud at
// startup if any field is missing description/example metadata.
const FILTERS_PROMPT = buildFiltersPrompt(SearchFiltersSchema);
const FILTERS_PROMPT_VERSION = computeFiltersPromptVersion(FILTERS_PROMPT);

/**
 * GET /search/filters-prompt — returns a markdown prompt fragment generated
 * from SearchFiltersSchema. Single source of truth for caller LLMs that
 * generate search filters (e.g. lead-service). Cache by schemaVersion.
 */
router.get("/search/filters-prompt", serviceAuth, async (_req: AuthenticatedRequest, res) => {
  res.json({ prompt: FILTERS_PROMPT, schemaVersion: FILTERS_PROMPT_VERSION });
});

/**
 * POST /search/dry-run — cheap filter test. No DB writes, no cost tracking, no run creation.
 * Validates filters via SearchFiltersSchema, calls Apollo with per_page=1, returns totalEntries.
 * Designed to be hammered by an LLM testing many filter variants.
 */
router.post("/search/dry-run", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.orgId || !req.userId) {
      return res.status(400).json({ totalEntries: 0, validationErrors: ["x-org-id and x-user-id headers required"] });
    }

    const parsed = SearchDryRunRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const flat = parsed.error.flatten();
      const validationErrors = [
        ...flat.formErrors,
        ...Object.entries(flat.fieldErrors).flatMap(([k, v]) => (v ?? []).map((m) => `${k}: ${m}`)),
      ];
      return res.status(400).json({ totalEntries: 0, validationErrors });
    }

    const { key: apolloApiKey } = await decryptKey(
      req.orgId,
      req.userId,
      "apollo",
      { callerMethod: "POST", callerPath: "/search/dry-run" },
      { brandIds: req.brandIds, campaignId: req.campaignId, featureSlug: req.featureSlug, workflowSlug: req.workflowSlug }
    );

    const apolloParams = {
      ...toApolloSearchParams(parsed.data),
      page: 1,
      per_page: 1,
    };
    const result = await searchPeople(apolloApiKey, apolloParams);
    const totalEntries = result.total_entries ?? result.pagination?.total_entries ?? 0;

    res.json({ totalEntries, validationErrors: [] });
  } catch (error) {
    console.error("[Apollo Service][POST /search/dry-run] ERROR:", error);
    res.status(500).json({ type: "internal", error: error instanceof Error ? error.message : "Internal server error" });
  }
});

/**
 * Look up a cached enrichment by Apollo person id.
 * - Positive cache (has email): 12-month TTL
 * - Negative cache (no email, waterfall not pending): 24h TTL
 * - Lazy cleanup: pending > 24h → cancel provisioned cost, add worst-case actual, mark expired
 *
 * Mirrors `findCachedMatch` in src/routes/match.ts. See CLAUDE.md
 * "Waterfall enrichment — canonical pattern" for the full flow.
 */
async function findCachedEnrichmentByPersonId(
  apolloPersonId: string,
): Promise<{ record: typeof apolloPeopleEnrichments.$inferSelect; negative: boolean } | null> {
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

  const [positive] = await db
    .select()
    .from(apolloPeopleEnrichments)
    .where(
      and(
        eq(apolloPeopleEnrichments.apolloPersonId, apolloPersonId),
        isNotNull(apolloPeopleEnrichments.email),
        gt(apolloPeopleEnrichments.createdAt, twelveMonthsAgo),
      ),
    )
    .orderBy(desc(apolloPeopleEnrichments.createdAt))
    .limit(1);

  if (positive) return { record: positive, negative: false };

  // Negative cache:
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
        eq(apolloPeopleEnrichments.apolloPersonId, apolloPersonId),
        sql`${apolloPeopleEnrichments.email} IS NULL`,
        sql`(
          (COALESCE(${apolloPeopleEnrichments.waterfallStatus}, '') NOT IN ('pending') AND ${apolloPeopleEnrichments.createdAt} > ${twentyFourHoursAgoISO})
          OR
          (${apolloPeopleEnrichments.waterfallStatus} = 'pending' AND ${apolloPeopleEnrichments.createdAt} <= ${twentyFourHoursAgoISO})
        )`,
      ),
    )
    .orderBy(desc(apolloPeopleEnrichments.createdAt))
    .limit(1);

  if (negative) {
    if (negative.waterfallStatus === "pending") {
      await expireStalePendingWaterfall(negative);
    }
    return { record: negative, negative: true };
  }

  return null;
}

/**
 * POST /enrich - Enrich a single person via Apollo to reveal their email
 */
router.post("/enrich", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { runId, brandIds, campaignId, featureSlug, workflowSlug } = req;
    if (!runId || !brandIds?.length || !campaignId) {
      return res.status(400).json({ type: "validation", error: "x-run-id, x-brand-id, and x-campaign-id headers required" });
    }
    const identity: IdentityHeaders = { orgId: req.orgId!, userId: req.userId, brandIds, campaignId, featureSlug, workflowSlug };
    const tracking = { brandIds, campaignId, featureSlug, workflowSlug };

    const parsed = EnrichRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ type: "validation", error: "Invalid request", details: parsed.error.flatten() });
    }
    const { apolloPersonId } = parsed.data;

    traceEvent(runId, { service: "apollo-service", event: "enrich-start", detail: `apolloPersonId=${apolloPersonId}` }, req.headers).catch(() => {});

    const cacheHit = await findCachedEnrichmentByPersonId(apolloPersonId);

    if (cacheHit) {
      traceEvent(runId, { service: "apollo-service", event: "enrich-cache-hit", detail: `apolloPersonId=${apolloPersonId}, negative=${cacheHit.negative}` }, req.headers).catch(() => {});
      const cachedRun = await createRun({
        orgId: req.orgId!,
        userId: req.userId,
        brandIds,
        campaignId,
        serviceName: "apollo-service",
        taskName: "enrichment",
        parentRunId: runId,
        workflowSlug,
      });
      await updateRun(cachedRun.id, "completed", identity);

      return res.json({
        enrichmentId: null,
        person: cacheHit.negative ? null : transformCachedEnrichment(apolloPersonId, cacheHit.record),
        cached: true,
      });
    }

    const { key: apolloApiKey, keySource } = await decryptKey(req.orgId!, req.userId!, "apollo", { callerMethod: "POST", callerPath: "/enrich" }, tracking);
    assertKeySource(keySource);

    // Authorize the worst-case waterfall cost. Authorize quantity must match the
    // ceiling we may bill via the webhook reconciliation, not the immediate
    // (no-waterfall) cost of 1 credit.
    if (keySource === "platform") {
      const auth = await authorizeCredit({
        items: [{ costName: "apollo-credit", quantity: WATERFALL_MAX_CREDITS }],
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
    const result = await enrichPerson(apolloApiKey, apolloPersonId, webhookUrl);
    const person = result.person;
    const waterfallAccepted = result.waterfall?.status === "accepted";
    const waterfallRequestId = result.request_id ? String(result.request_id) : null;

    let enrichmentId: string | null = null;
    let provisionedCostId: string | null = null;

    if (person) {
      const enrichRun = await createRun({
        orgId: req.orgId!,
        userId: req.userId,
        brandIds,
        campaignId,
        serviceName: "apollo-service",
        taskName: "enrichment",
        parentRunId: runId,
        workflowSlug,
      });

      if (!person.email && waterfallAccepted) {
        provisionedCostId = await provisionWaterfallCost(enrichRun.id, keySource, identity);
      }

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
        provisionedCostId,
      }).returning();

      enrichmentId = enrichment.id;

      if (person.email) {
        await addCosts(enrichRun.id, [{ costName: "apollo-credit", costSource: keySource, quantity: 1 }], identity);
      } else if (waterfallAccepted && enrichmentId) {
        traceEvent(runId, { service: "apollo-service", event: "waterfall-poll-start", detail: `enrichmentId=${enrichmentId}, waterfallRequestId=${waterfallRequestId}` }, req.headers).catch(() => {});

        const pollResult = await pollForWaterfallEmail(enrichmentId);

        if (pollResult.resolved) {
          if (pollResult.record?.email) {
            traceEvent(runId, { service: "apollo-service", event: "waterfall-poll-success", detail: `email found via waterfall` }, req.headers).catch(() => {});

            if (provisionedCostId) {
              await updateCostStatus(enrichRun.id, provisionedCostId, "cancelled", identity);
            }

            await updateRun(enrichRun.id, "completed", identity);

            const transformed = transformCachedEnrichment(pollResult.record.apolloPersonId ?? person.id, pollResult.record);
            return res.json({ enrichmentId, person: transformed, cached: false });
          }

          if (provisionedCostId) {
            await updateCostStatus(enrichRun.id, provisionedCostId, "cancelled", identity);
          }
          await updateRun(enrichRun.id, "completed", identity);

          traceEvent(runId, { service: "apollo-service", event: "enrich-done", detail: `enrichmentId=${enrichmentId}, hasEmail=false, waterfallResolved=true` }, req.headers).catch(() => {});

          return res.json({ enrichmentId, person: null, cached: false });
        }

        // Timeout — webhook will reconcile when it eventually arrives.
        await db.update(apolloPeopleEnrichments)
          .set({ waterfallStatus: "timeout" })
          .where(eq(apolloPeopleEnrichments.id, enrichmentId));

        console.error(`[apollo-service] Waterfall polling timeout: enrichment ${enrichmentId} (waterfallRequestId=${waterfallRequestId})`);
        traceEvent(runId, { service: "apollo-service", event: "waterfall-poll-timeout", detail: `enrichmentId=${enrichmentId}, waterfallRequestId=${waterfallRequestId}`, level: "error" }, req.headers).catch(() => {});

        await updateRun(enrichRun.id, "failed", identity);

        return res.status(504).json({
          type: "waterfall_timeout",
          error: "Waterfall email enrichment timeout — webhook did not arrive within poll window",
          enrichmentId,
        });
      }

      await updateRun(enrichRun.id, "completed", identity);
    }

    const transformed = person ? transformApolloPerson(person) : null;

    traceEvent(runId, { service: "apollo-service", event: "enrich-done", detail: `enrichmentId=${enrichmentId}, hasEmail=${!!person?.email}, waterfallAccepted=${waterfallAccepted}`, data: { enrichmentId, hasEmail: !!person?.email } }, req.headers).catch(() => {});

    res.json({ enrichmentId, person: transformed, cached: false });
  } catch (error) {
    console.error("[Apollo Service][POST /enrich] ERROR:", error);
    if (req.runId) {
      traceEvent(req.runId, { service: "apollo-service", event: "enrich-error", detail: error instanceof Error ? error.message : "Unknown error", level: "error" }, req.headers).catch(() => {});
    }
    res.status(500).json({ type: "internal", error: error instanceof Error ? error.message : "Internal server error" });
  }
});

/**
 * POST /search/next - Server-managed pagination for campaign searches.
 * First call with searchParams starts a new search cursor.
 * Subsequent calls return the next batch of unseen people.
 */
router.post("/search/next", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { runId, brandIds, campaignId, featureSlug, workflowSlug } = req;
    if (!runId || !brandIds?.length || !campaignId) {
      return res.status(400).json({ type: "validation", error: "x-run-id, x-brand-id, and x-campaign-id headers required" });
    }
    const identity: IdentityHeaders = { orgId: req.orgId!, userId: req.userId, brandIds, campaignId, featureSlug, workflowSlug };
    const tracking = { brandIds, campaignId, featureSlug, workflowSlug };

    const parsed = SearchNextRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ type: "validation", error: "Invalid request", details: parsed.error.flatten() });
    }
    const { searchParams } = parsed.data;

    traceEvent(runId, { service: "apollo-service", event: "search-next-start", detail: `campaignId=${campaignId}, hasSearchParams=${!!searchParams}` }, req.headers).catch(() => {});

    // Create child run BEFORE external Apollo call so a runs-service outage fails loud and skips the API call.
    const searchRun = await createRun({
      orgId: req.orgId!,
      userId: req.userId,
      brandIds,
      campaignId,
      featureSlug,
      serviceName: "apollo-service",
      taskName: "people-search-next",
      parentRunId: runId,
      workflowSlug,
    });

    const { key: apolloApiKey } = await decryptKey(req.orgId!, req.userId!, "apollo", { callerMethod: "POST", callerPath: "/search/next" }, tracking);

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
        await updateRun(searchRun.id, "completed", identity);
        return res.status(400).json({
          type: "validation",
          error: "No search cursor found for this campaign. Provide searchParams to start a new search.",
        });
      }
      cursorSearchParams = existingCursor.searchParams as Record<string, unknown>;
      currentPage = existingCursor.currentPage;
      isExhausted = existingCursor.exhausted;
    }

    // If already exhausted, return immediately
    if (isExhausted) {
      await updateRun(searchRun.id, "completed", identity);
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
      per_page: DEFAULT_PER_PAGE,
    };
    const result = await searchPeople(apolloApiKey, apolloParams);
    const totalEntries = result.total_entries ?? result.pagination?.total_entries ?? 0;
    const people = result.people ?? [];

    if (people.length < 1) {
      console.warn(`[Apollo Service][POST /search/next] ⚠ Apollo returned 0 people page=${currentPage} campaignId=${campaignId} runId=${runId} (cursor stays open — totalPages drives exhaustion)`);
    } else {
      console.log(`[Apollo Service][POST /search/next] Found ${people.length} people page=${currentPage} (${totalEntries} total) campaignId=${campaignId} runId=${runId}`);
    }

    // Advance cursor. Apollo's totalPages is the source of truth — only
    // mark exhausted when we've read past the last page. Mid-stream empty
    // pages are transient and must not poison the cursor.
    const nextPage = currentPage + 1;
    const totalPages = Math.ceil(totalEntries / DEFAULT_PER_PAGE);
    const done = nextPage > totalPages;

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

    // Store search record (audit trail). Costs not tracked — search is free.
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
    res.status(500).json({ type: "internal", error: error instanceof Error ? error.message : "Internal server error" });
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
    res.status(500).json({ type: "internal", error: "Internal server error" });
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
        hint: "Check: was POST /search/next called with this runId? Was x-org-id the same?",
      });
    }

    res.json({ enrichments });
  } catch (error) {
    console.error("[Apollo Service][GET /enrichments] ERROR:", error);
    res.status(500).json({ type: "internal", error: "Internal server error" });
  }
});

/**
 * POST /stats - Get aggregated stats with optional filters and groupBy
 * Body: { runIds?, brandIds?, campaignId?, workflowSlug?, featureSlug?,
 *         workflowDynastySlug?, featureDynastySlug?, groupBy? }
 * orgId is always applied from auth. All body filters are optional.
 */
router.post("/stats", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const parsed = StatsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ type: "validation", error: "Invalid request", details: parsed.error.flatten() });
    }
    const {
      runIds, brandIds, campaignId,
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
      if (brandIds?.length) conditions.push(arrayOverlaps(table.brandIds, brandIds));
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
    res.status(500).json({ type: "internal", error: "Internal server error" });
  }
});

export default router;
