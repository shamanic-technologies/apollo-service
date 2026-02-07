import { Router } from "express";
import { eq, and, gt, isNotNull, desc, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { apolloPeopleSearches, apolloPeopleEnrichments } from "../db/schema.js";
import { serviceAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { searchPeople, enrichPerson, ApolloSearchParams, ApolloPerson } from "../lib/apollo-client.js";
import { getByokKey } from "../lib/keys-client.js";
import { ensureOrganization, createRun, updateRun, addCosts } from "../lib/runs-client.js";

const router = Router();

/**
 * POST /search - Search for people via Apollo
 * runId is optional - if provided, links to a runs-service run (campaign workflow)
 */
router.post("/search", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { runId, ...searchParams } = req.body;

    console.log("[Apollo Service][POST /search] called", {
      orgId: req.orgId,
      clerkOrgId: req.clerkOrgId,
      runId: runId ?? "(none - results will NOT be stored in DB)",
      searchParams,
    });

    // Get Apollo API key from key-service
    const apolloApiKey = await getByokKey(req.clerkOrgId!, "apollo");

    // Call Apollo API
    const apolloParams: ApolloSearchParams = {
      person_titles: searchParams.personTitles,
      q_organization_keyword_tags: searchParams.qOrganizationKeywordTags,
      organization_locations: searchParams.organizationLocations,
      organization_num_employees_ranges: searchParams.organizationNumEmployeesRanges,
      q_organization_industry_tag_ids: searchParams.qOrganizationIndustryTagIds,
      q_keywords: searchParams.qKeywords,
      page: searchParams.page || 1,
      per_page: searchParams.perPage || 25,
    };

    // Create a child run in runs-service for this search
    let searchRunId: string | undefined;
    if (runId) {
      try {
        const runsOrgId = await ensureOrganization(req.clerkOrgId!);
        const searchRun = await createRun({
          organizationId: runsOrgId,
          serviceName: "apollo-service",
          taskName: "people-search",
          parentRunId: runId,
        });
        searchRunId = searchRun.id;
      } catch (err) {
        console.warn("[Apollo Service] Failed to create search run in runs-service:", err);
      }
    }

    const result = await searchPeople(apolloApiKey, apolloParams);

    // Get total entries (new API format has it at root level)
    const totalEntries = result.total_entries ?? result.pagination?.total_entries ?? 0;

    console.log("[Apollo Service][POST /search] Apollo API response", {
      orgId: req.orgId,
      runId,
      peopleReturned: result.people?.length ?? 0,
      totalEntries,
      haspeople: !!result.people,
      rawPeopleType: typeof result.people,
    });

    if (!result.people || result.people.length === 0) {
      console.warn("[Apollo Service][POST /search] ⚠ Apollo returned 0 people", {
        orgId: req.orgId,
        runId,
        apolloParams,
        totalEntries,
        rawResponseKeys: Object.keys(result),
      });
    }

    // Only store records if runId is provided (campaign workflow)
    let searchId: string | null = null;
    if (runId) {
      // Store search record
      const [search] = await db
        .insert(apolloPeopleSearches)
        .values({
          orgId: req.orgId!,
          runId,
          requestParams: apolloParams,
          peopleCount: result.people.length,
          totalEntries,
          responseRaw: result,
        })
        .returning();

      searchId = search.id;

      console.log("[Apollo Service][POST /search] search record stored in DB", {
        searchId: search.id,
        orgId: req.orgId,
        runId,
        peopleToStore: result.people.length,
      });

      // Store enrichment records and track each in runs-service
      const runsOrgId = await ensureOrganization(req.clerkOrgId!);

      for (const person of result.people as ApolloPerson[]) {
        const [enrichment] = await db.insert(apolloPeopleEnrichments).values({
          orgId: req.orgId!,
          runId,
          searchId: search.id,
          apolloPersonId: person.id,
          firstName: person.first_name,
          lastName: person.last_name,
          email: person.email,
          emailStatus: person.email_status,
          title: person.title,
          linkedinUrl: person.linkedin_url,
          organizationName: person.organization?.name,
          organizationDomain: person.organization?.primary_domain,
          organizationIndustry: person.organization?.industry,
          organizationSize: person.organization?.estimated_num_employees?.toString(),
          organizationRevenueUsd: person.organization?.annual_revenue?.toString(),
          responseRaw: person,
        }).returning();

        // Create grandchild run + post costs in runs-service
        if (searchRunId) {
          try {
            const enrichRun = await createRun({
              organizationId: runsOrgId,
              serviceName: "apollo-service",
              taskName: "enrichment",
              parentRunId: searchRunId,
            });

            // Link enrichment run to record IMMEDIATELY so per-item cost
            // lookups work even if addCosts/updateRun fail below
            await db.update(apolloPeopleEnrichments)
              .set({ enrichmentRunId: enrichRun.id })
              .where(eq(apolloPeopleEnrichments.id, enrichment.id));

            await addCosts(enrichRun.id, [{ costName: "apollo-enrichment-credit", quantity: 1 }]);
            await updateRun(enrichRun.id, "completed");
          } catch (err) {
            console.error("[Apollo Service] COST TRACKING FAILED for enrichment — costs will be missing from campaign totals.", {
              runId,
              searchRunId,
              personId: person.id,
              costName: "apollo-enrichment-credit",
              error: err instanceof Error ? err.message : err,
            });
          }
        }
      }

      // Mark search run as completed
      if (searchRunId) {
        try {
          await addCosts(searchRunId, [{ costName: "apollo-search-credit", quantity: 1 }]);
          await updateRun(searchRunId, "completed");
        } catch (err) {
          console.error("[Apollo Service] COST TRACKING FAILED for search — costs will be missing from campaign totals.", {
            runId,
            searchRunId,
            costName: "apollo-search-credit",
            error: err instanceof Error ? err.message : err,
          });
        }
      }
    }

    if (!runId) {
      console.warn("[Apollo Service][POST /search] ⚠ No runId provided — results returned but NOT stored in DB. GET /enrichments will return 0 for this search.");
    }

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
      return {
        id: person.id,
        firstName: person.first_name,
        lastName: person.last_name,
        email: person.email ?? cached?.email ?? null,
        emailStatus: person.email_status ?? cached?.emailStatus ?? null,
        title: person.title,
        linkedinUrl: person.linkedin_url,
        organizationName: person.organization?.name,
        organizationDomain: person.organization?.primary_domain,
        organizationIndustry: person.organization?.industry,
        organizationSize: person.organization?.estimated_num_employees?.toString(),
      };
    });

    console.log("[Apollo Service][POST /search] responding", {
      searchId,
      peopleCount: result.people.length,
      totalEntries,
      storedInDb: !!runId,
    });

    res.json({
      searchId,
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
 * Body: { apolloPersonId: string, runId?: string }
 */
router.post("/enrich", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { apolloPersonId, runId } = req.body;

    if (!apolloPersonId) {
      return res.status(400).json({ error: "apolloPersonId is required" });
    }

    console.log("[Apollo Service][POST /enrich] called", {
      orgId: req.orgId,
      clerkOrgId: req.clerkOrgId,
      apolloPersonId,
      runId: runId ?? "(none)",
    });

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
      console.log("[Apollo Service][POST /enrich] cache hit", {
        apolloPersonId,
        cachedEmail: cached.email,
      });
      return res.json({
        enrichmentId: null,
        person: {
          id: apolloPersonId,
          firstName: cached.firstName,
          lastName: cached.lastName,
          email: cached.email,
          emailStatus: cached.emailStatus,
          title: cached.title,
          linkedinUrl: cached.linkedinUrl,
          organizationName: cached.organizationName,
          organizationDomain: cached.organizationDomain,
          organizationIndustry: cached.organizationIndustry,
          organizationSize: cached.organizationSize,
        },
      });
    }

    const apolloApiKey = await getByokKey(req.clerkOrgId!, "apollo");
    const result = await enrichPerson(apolloApiKey, apolloPersonId);
    const person = result.person;

    console.log("[Apollo Service][POST /enrich] Apollo API response", {
      orgId: req.orgId,
      apolloPersonId,
      hasEmail: !!person?.email,
      emailStatus: person?.email_status,
    });

    // Store enrichment record and track costs if runId provided
    let enrichmentId: string | null = null;
    if (runId && person) {
      const [enrichment] = await db.insert(apolloPeopleEnrichments).values({
        orgId: req.orgId!,
        runId,
        apolloPersonId: person.id,
        firstName: person.first_name,
        lastName: person.last_name,
        email: person.email,
        emailStatus: person.email_status,
        title: person.title,
        linkedinUrl: person.linkedin_url,
        organizationName: person.organization?.name,
        organizationDomain: person.organization?.primary_domain,
        organizationIndustry: person.organization?.industry,
        organizationSize: person.organization?.estimated_num_employees?.toString(),
        organizationRevenueUsd: person.organization?.annual_revenue?.toString(),
        responseRaw: person,
      }).returning();

      enrichmentId = enrichment.id;

      // Track cost in runs-service
      try {
        const runsOrgId = await ensureOrganization(req.clerkOrgId!);
        const enrichRun = await createRun({
          organizationId: runsOrgId,
          serviceName: "apollo-service",
          taskName: "enrichment",
          parentRunId: runId,
        });

        await db.update(apolloPeopleEnrichments)
          .set({ enrichmentRunId: enrichRun.id })
          .where(eq(apolloPeopleEnrichments.id, enrichment.id));

        await addCosts(enrichRun.id, [{ costName: "apollo-enrichment-credit", quantity: 1 }]);
        await updateRun(enrichRun.id, "completed");
      } catch (err) {
        console.error("[Apollo Service] COST TRACKING FAILED for enrichment", {
          runId,
          apolloPersonId,
          error: err instanceof Error ? err.message : err,
        });
      }
    }

    const transformed = person ? {
      id: person.id,
      firstName: person.first_name,
      lastName: person.last_name,
      email: person.email,
      emailStatus: person.email_status,
      title: person.title,
      linkedinUrl: person.linkedin_url,
      organizationName: person.organization?.name,
      organizationDomain: person.organization?.primary_domain,
      organizationIndustry: person.organization?.industry,
      organizationSize: person.organization?.estimated_num_employees?.toString(),
    } : null;

    res.json({ enrichmentId, person: transformed });
  } catch (error) {
    console.error("[Apollo Service][POST /enrich] ERROR:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

/**
 * GET /searches/:runId - Get all searches for a run
 */
router.get("/searches/:runId", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { runId } = req.params;

    console.log("[Apollo Service][GET /searches] query", {
      runId,
      orgId: req.orgId,
      clerkOrgId: req.clerkOrgId,
    });

    const searches = await db.query.apolloPeopleSearches.findMany({
      where: (searches, { eq, and }) =>
        and(
          eq(searches.runId, runId),
          eq(searches.orgId, req.orgId!)
        ),
    });

    console.log("[Apollo Service][GET /searches] found", {
      runId,
      orgId: req.orgId,
      count: searches.length,
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

    console.log("[Apollo Service][GET /enrichments] query", {
      runId,
      orgId: req.orgId,
      clerkOrgId: req.clerkOrgId,
    });

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
    } else {
      console.log("[Apollo Service][GET /enrichments] found", {
        runId,
        orgId: req.orgId,
        count: enrichments.length,
      });
    }

    res.json({ enrichments });
  } catch (error) {
    console.error("[Apollo Service][GET /enrichments] ERROR:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /stats - Get aggregated stats for multiple run IDs
 * Body: { runIds: string[] }
 */
router.post("/stats", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { runIds } = req.body as { runIds: string[] };

    console.log("[Apollo Service][POST /stats] called", {
      orgId: req.orgId,
      clerkOrgId: req.clerkOrgId,
      runIdsCount: runIds?.length ?? 0,
      runIds: runIds?.slice(0, 10), // log first 10 max
    });

    if (!runIds || !Array.isArray(runIds)) {
      return res.status(400).json({ error: "runIds array required" });
    }

    if (runIds.length === 0) {
      console.warn("[Apollo Service][POST /stats] ⚠ empty runIds array — returning 0");
      return res.json({ stats: { leadsFound: 0, searchesCount: 0 } });
    }

    // Count enrichments (leads found)
    const enrichments = await db.query.apolloPeopleEnrichments.findMany({
      where: (e, { and, eq, inArray }) =>
        and(
          inArray(e.runId, runIds),
          eq(e.orgId, req.orgId!)
        ),
      columns: { id: true },
    });

    // Count searches
    const searches = await db.query.apolloPeopleSearches.findMany({
      where: (s, { and, eq, inArray }) =>
        and(
          inArray(s.runId, runIds),
          eq(s.orgId, req.orgId!)
        ),
      columns: { id: true, peopleCount: true },
    });

    const totalPeopleFromSearches = searches.reduce((sum, s) => sum + (s.peopleCount || 0), 0);

    console.log("[Apollo Service][POST /stats] results", {
      orgId: req.orgId,
      leadsFound: enrichments.length,
      searchesCount: searches.length,
      totalPeopleFromSearches,
    });

    if (enrichments.length === 0) {
      console.warn("[Apollo Service][POST /stats] ⚠ 0 leads found for runIds", {
        orgId: req.orgId,
        runIds: runIds.slice(0, 10),
        searchesCount: searches.length,
        hint: "If searchesCount > 0 but leadsFound = 0, enrichments may not have been stored (missing runId on POST /search?)",
      });
    }

    res.json({
      stats: {
        leadsFound: enrichments.length,
        searchesCount: searches.length,
        totalPeopleFromSearches,
      },
    });
  } catch (error) {
    console.error("[Apollo Service][POST /stats] ERROR:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
