import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { apolloAudiences } from "../db/schema.js";
import { serviceAuth, orgAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { decryptKey } from "../lib/keys-client.js";
import { buildFiltersPrompt } from "../lib/filters-prompt.js";
import { refineAudience, dryRunCount } from "../lib/audience-refine.js";
import { SuggestFromSegmentRequestSchema, ApolloNativeSearchFiltersSchema } from "../schemas.js";

const router = Router();

// Apollo-native catalog, computed once at module load. Fed to the refine loop's
// LLM so it builds only valid canonical Apollo filters.
const FILTERS_PROMPT = buildFiltersPrompt(ApolloNativeSearchFiltersSchema);

/**
 * POST /audiences/suggest-from-segment — run the agentic NL→faithful-Apollo-
 * filters refine loop (LLM via chat-service, free dry-runs for live counts) and
 * persist the confirmed audience. Returns { apolloAudienceId, filters, count }.
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

    const [row] = await db
      .insert(apolloAudiences)
      .values({
        orgId: req.orgId!,
        userId: req.userId,
        brandId: brandId ?? null,
        name,
        description,
        filters: refined.filters,
        count: refined.count,
        refineTrace: refined.trace,
        status: refined.status,
      })
      .returning();

    res.json({ apolloAudienceId: row.id, filters: refined.filters, count: refined.count });
  } catch (error) {
    console.error("[Apollo Service][POST /audiences/suggest-from-segment] ERROR:", error);
    res.status(500).json({ type: "internal", error: error instanceof Error ? error.message : "Internal server error" });
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

    const count = await dryRunCount(apolloApiKey, row.filters as Record<string, unknown>);

    await db
      .update(apolloAudiences)
      .set({ count, countRefreshedAt: new Date(), updatedAt: new Date() })
      .where(eq(apolloAudiences.id, apolloAudienceId));

    res.json({ count });
  } catch (error) {
    console.error("[Apollo Service][POST /audiences/:id/dry-run] ERROR:", error);
    res.status(500).json({ type: "internal", error: error instanceof Error ? error.message : "Internal server error" });
  }
});

export default router;
