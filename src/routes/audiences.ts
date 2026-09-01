import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { apolloAudiences } from "../db/schema.js";
import { serviceAuth, orgAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { decryptKey } from "../lib/keys-client.js";
import { buildFiltersPrompt, APOLLO_UNDOCUMENTED_FILTERS_ENCART } from "../lib/filters-prompt.js";
import { refineAudience, dryRunCount } from "../lib/audience-refine.js";
import { toCreditAlertIdentity } from "../lib/credit-alert.js";
import { SuggestFromSegmentRequestSchema, ApolloNativeSearchFiltersSchema } from "../schemas.js";
import { providerErrorFields } from "../lib/provider-error.js";

const router = Router();

// Apollo-native catalog, computed once at module load. Fed to the refine loop's
// LLM so it builds only valid canonical Apollo filters. The UNDOCUMENTED-but-
// verified rules encart (funding filters + stage code map + "unknown params are
// silently dropped") is appended so the LLM can use them and they survive a
// future doc re-sync of the schema.
const FILTERS_PROMPT = `${buildFiltersPrompt(ApolloNativeSearchFiltersSchema)}\n\n${APOLLO_UNDOCUMENTED_FILTERS_ENCART}`;

/**
 * POST /audiences/suggest-from-segment — run the agentic NL→faithful-Apollo-
 * filters refine loop (LLM via chat-service, free dry-runs for live counts) and
 * persist EVERY round it explored, each as its own apollo_audiences row.
 *
 * Returns `candidates`: one entry per round, in round order, carrying that
 * round's persisted apolloAudienceId, its filters, its live count, its 10
 * random-page sample rows and the model's three notes. This service explores and
 * reports; WHICH audience serves the customer is a product decision made by
 * human-service, which did not author the sets. Nothing here ranks or sorts.
 *
 * The single-result fields (apolloAudienceId / filters / count / degraded) are
 * kept ADDITIVELY, behaving as before (largest non-empty round, degraded false),
 * so human-service can migrate to `candidates` on its own schedule. A later PR
 * removes them.
 */
router.post("/audiences/suggest-from-segment", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const parsed = SuggestFromSegmentRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ type: "validation", error: "Invalid request", details: parsed.error.flatten() });
    }
    const { name, description, brandId } = parsed.data;

    const brandIds = brandId ? [brandId] : req.brandIds;
    const tracking = {
      brandIds,
      campaignId: req.campaignId,
      audienceId: req.audienceId,
      featureSlug: req.featureSlug,
      workflowSlug: req.workflowSlug,
    };

    const { key: apolloApiKey } = await decryptKey(
      req.orgId!,
      req.userId!,
      "apollo",
      { callerMethod: "POST", callerPath: "/audiences/suggest-from-segment" },
      tracking,
    );

    const refined = await refineAudience({
      name,
      description,
      filtersPromptCatalog: FILTERS_PROMPT,
      apolloApiKey,
      tracking: {
        orgId: req.orgId!,
        userId: req.userId,
        runId: req.runId,
        brandIds,
        campaignId: req.campaignId,
        featureSlug: req.featureSlug,
        workflowSlug: req.workflowSlug,
      },
    });

    // One row per explored round. Rows are cheap and the ones nobody picks are a
    // useful record of what the loop tried. Every row carries the WHOLE run's
    // trace as its bronze — that is the run that produced it.
    const rows = await db
      .insert(apolloAudiences)
      .values(
        refined.candidates.map((c) => ({
          orgId: req.orgId!,
          userId: req.userId,
          brandId: brandId ?? null,
          name,
          description,
          filters: c.filters,
          count: c.count,
          refineTrace: refined.trace,
          status: refined.status,
        })),
      )
      .returning();

    const candidates = refined.candidates.map((c, i) => ({
      apolloAudienceId: rows[i].id,
      round: c.round,
      filters: c.filters,
      count: c.count,
      sample: c.sample,
      notes: c.notes,
    }));

    // The legacy single result points at the row of the largest non-empty round.
    const legacy = candidates.find((c) => c.filters === refined.filters) ?? candidates[candidates.length - 1];

    res.json({
      apolloAudienceId: legacy.apolloAudienceId,
      filters: refined.filters,
      count: refined.count,
      degraded: refined.degraded,
      candidates,
    });
  } catch (error) {
    console.error("[Apollo Service][POST /audiences/suggest-from-segment] ERROR:", error);
    res.status(500).json({ type: "internal", error: error instanceof Error ? error.message : "Internal server error", ...providerErrorFields(error) });
  }
});

/**
 * GET /audiences/:apolloAudienceId — fetch a persisted audience (org-scoped).
 */
router.get("/audiences/:apolloAudienceId", orgAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { apolloAudienceId } = req.params;

    const [row] = await db
      .select()
      .from(apolloAudiences)
      .where(and(eq(apolloAudiences.id, apolloAudienceId), eq(apolloAudiences.orgId, req.orgId!)))
      .limit(1);

    if (!row) {
      return res.status(404).json({ type: "not_found", error: "Audience not found" });
    }

    res.json({
      apolloAudienceId: row.id,
      filters: row.filters,
      count: row.count,
      status: row.status,
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    });
  } catch (error) {
    console.error("[Apollo Service][GET /audiences/:id] ERROR:", error);
    res.status(500).json({ type: "internal", error: "Internal server error" });
  }
});

/**
 * POST /audiences/:apolloAudienceId/dry-run — re-count the stored filters via a
 * free Apollo dry-run and refresh the count snapshot. Returns { count }.
 */
router.post("/audiences/:apolloAudienceId/dry-run", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { apolloAudienceId } = req.params;

    const [row] = await db
      .select()
      .from(apolloAudiences)
      .where(and(eq(apolloAudiences.id, apolloAudienceId), eq(apolloAudiences.orgId, req.orgId!)))
      .limit(1);

    if (!row) {
      return res.status(404).json({ type: "not_found", error: "Audience not found" });
    }

    const { key: apolloApiKey } = await decryptKey(
      req.orgId!,
      req.userId!,
      "apollo",
      { callerMethod: "POST", callerPath: "/audiences/:apolloAudienceId/dry-run" },
      { brandIds: row.brandId ? [row.brandId] : req.brandIds, featureSlug: req.featureSlug, workflowSlug: req.workflowSlug },
    );

    const count = await dryRunCount(apolloApiKey, row.filters as Record<string, unknown>, toCreditAlertIdentity(req));

    await db
      .update(apolloAudiences)
      .set({ count, countRefreshedAt: new Date(), updatedAt: new Date() })
      .where(eq(apolloAudiences.id, apolloAudienceId));

    res.json({ count });
  } catch (error) {
    console.error("[Apollo Service][POST /audiences/:id/dry-run] ERROR:", error);
    res.status(500).json({ type: "internal", error: error instanceof Error ? error.message : "Internal server error", ...providerErrorFields(error) });
  }
});

export default router;
