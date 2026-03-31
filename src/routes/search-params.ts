import { createHash } from "node:crypto";
import { Router } from "express";
import { eq, and, gt } from "drizzle-orm";
import { db } from "../db/index.js";
import { apolloSearchParamsCache } from "../db/schema.js";
import { serviceAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { searchPeople } from "../lib/apollo-client.js";
import { decryptKey } from "../lib/keys-client.js";
import { createRun, updateRun, addCosts, type IdentityHeaders } from "../lib/runs-client.js";
import { authorizeCredit } from "../lib/billing-client.js";
import { callClaude } from "../lib/anthropic-client.js";
import { getSystemPrompt, buildUserMessage, SearchAttempt, PromptEnrichment } from "../lib/search-params-prompt.js";
import { toApolloSearchParams } from "../lib/transform.js";
import { SearchParamsRequestSchema, SearchFiltersSchema } from "../schemas.js";
import { getFeatureInputs } from "../lib/campaign-client.js";
import { extractBrandFields } from "../lib/brand-fields-client.js";

const router = Router();

const MAX_ATTEMPTS = 10;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function hashContext(context: string): string {
  return createHash("sha256").update(context).digest("hex");
}

/** Sorted CSV of brand IDs — deterministic key for cache unique constraint. */
function toBrandIdsKey(brandIds: string[]): string {
  return [...brandIds].sort().join(",");
}

/**
 * POST /search/params — Generate Apollo search parameters from context using LLM.
 * Validates against Apollo and retries with broadened filters if 0 results.
 * Results are cached for 24h per (orgId, brandId, contextHash).
 */
router.post("/search/params", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { runId, brandId, brandIds, campaignId, featureSlug, workflowSlug } = req;
    if (!runId || !brandIds?.length || !campaignId) {
      return res.status(400).json({ error: "x-run-id, x-brand-id, and x-campaign-id headers required" });
    }
    const identity: IdentityHeaders = { orgId: req.orgId!, userId: req.userId, brandId, campaignId, featureSlug, workflowSlug };
    const tracking = { brandId, campaignId, featureSlug, workflowSlug };

    const parsed = SearchParamsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    }

    const { context } = parsed.data;
    const contextHash = hashContext(context);
    const brandIdsKey = toBrandIdsKey(brandIds);

    // Check cache — same (orgId, brandIds, context) within 24h
    const cacheThreshold = new Date(Date.now() - CACHE_TTL_MS);
    const [cached] = await db
      .select()
      .from(apolloSearchParamsCache)
      .where(
        and(
          eq(apolloSearchParamsCache.orgId, req.orgId!),
          eq(apolloSearchParamsCache.brandIdsKey, brandIdsKey),
          eq(apolloSearchParamsCache.contextHash, contextHash),
          gt(apolloSearchParamsCache.createdAt, cacheThreshold)
        )
      )
      .limit(1);

    if (cached) {
      console.log("[Apollo Service][POST /search/params] Cache hit", {
        orgId: req.orgId,
        brandIds,
        contextHash,
        cachedAt: cached.createdAt,
      });

      // Still create a run for traceability (no costs — cache hit)
      const cachedRun = await createRun({
        orgId: req.orgId!,
        userId: req.userId,
        brandId,
        campaignId,
        serviceName: "apollo-service",
        taskName: "search-params-generation",
        parentRunId: runId,
        workflowSlug,
      });
      await updateRun(cachedRun.id, "completed", identity);

      return res.json({
        searchParams: cached.searchParams,
        totalResults: cached.totalResults,
        attempts: cached.attempts,
        attemptHistory: cached.attemptHistory ?? [],
        cached: true,
      });
    }

    // Cache miss — generate via LLM
    const caller = { callerMethod: "POST", callerPath: "/search/params" };
    const { key: apolloApiKey, keySource: apolloKeySource } = await decryptKey(req.orgId!, req.userId!, "apollo", caller, tracking);
    const { key: anthropicApiKey, keySource: anthropicKeySource } = await decryptKey(req.orgId!, req.userId!, "anthropic", caller, tracking);

    // Authorize credit before executing paid operations (platform keys only)
    // Estimate: 1 LLM call (~1000 input + ~500 output tokens) + 1 Apollo search (best case).
    // Actual costs tracked per-iteration via addCosts.
    const authItems: { costName: string; quantity: number }[] = [];
    if (anthropicKeySource === "platform") {
      authItems.push(
        { costName: "anthropic-sonnet-4.6-tokens-input", quantity: 1000 },
        { costName: "anthropic-sonnet-4.6-tokens-output", quantity: 500 },
      );
    }
    if (apolloKeySource === "platform") {
      authItems.push({ costName: "apollo-search-credit", quantity: 1 });
    }
    if (authItems.length > 0) {
      const auth = await authorizeCredit({
        items: authItems,
        description: "apollo-search-params-generation",
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

    // Fetch brand fields + campaign context in parallel (Convention 1 & 2)
    const [brandFieldResults, featureInputs] = await Promise.all([
      extractBrandFields([
        { key: "industry", description: "The brand's primary industry vertical" },
        { key: "target_geography", description: "Priority geographic markets for outreach" },
        { key: "ideal_lead_type", description: "Type of leads to target (decision-makers, executives, managers...)" },
        { key: "target_job_titles", description: "Job titles to prioritize in outreach" },
      ], identity),
      getFeatureInputs(campaignId, identity),
    ]);

    const brandFields: Record<string, unknown> = {};
    for (const f of brandFieldResults) {
      if (f.value != null) brandFields[f.key] = f.value;
    }

    const enrichment: PromptEnrichment = { brandFields, featureInputs };

    const paramRun = await createRun({
      orgId: req.orgId!,
      userId: req.userId,
      brandId,
      campaignId,
      featureSlug,
      serviceName: "apollo-service",
      taskName: "search-params-generation",
      parentRunId: runId,
      workflowSlug,
    });

    const systemPrompt = getSystemPrompt();
    const attemptHistory: SearchAttempt[] = [];
    let finalParams: Record<string, unknown> = {};
    let finalTotalResults = 0;

    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const userMessage = buildUserMessage(context, attemptHistory, enrichment);
        const llmResponse = await callClaude(anthropicApiKey, systemPrompt, userMessage);

        await addCosts(paramRun.id, [
          { costName: "anthropic-sonnet-4.6-tokens-input", costSource: anthropicKeySource, quantity: llmResponse.inputTokens },
          { costName: "anthropic-sonnet-4.6-tokens-output", costSource: anthropicKeySource, quantity: llmResponse.outputTokens },
        ], identity);

        let rawParams: Record<string, unknown>;
        try {
          const cleaned = llmResponse.content.trim().replace(/^```json?\s*/, "").replace(/\s*```$/, "");
          rawParams = JSON.parse(cleaned);
        } catch {
          console.warn(`[Apollo Service][POST /search/params] Attempt ${attempt}: invalid JSON from LLM`, {
            content: llmResponse.content.substring(0, 200),
          });
          attemptHistory.push({ searchParams: {}, totalResults: 0 });
          continue;
        }

        const validated = SearchFiltersSchema.safeParse(rawParams);
        if (!validated.success) {
          console.warn(`[Apollo Service][POST /search/params] Attempt ${attempt}: schema validation failed`, {
            errors: validated.error.flatten(),
          });
          attemptHistory.push({ searchParams: rawParams, totalResults: 0 });
          continue;
        }

        const searchParams = validated.data as Record<string, unknown>;

        const apolloParams = {
          ...toApolloSearchParams(searchParams),
          page: 1,
          per_page: 1,
        };

        const result = await searchPeople(apolloApiKey, apolloParams);
        const totalResults = result.total_entries ?? result.pagination?.total_entries ?? 0;

        await addCosts(paramRun.id, [{ costName: "apollo-search-credit", costSource: apolloKeySource, quantity: 1 }], identity);

        console.log(`[Apollo Service][POST /search/params] Attempt ${attempt}: ${totalResults} results`, {
          searchParams,
        });

        attemptHistory.push({ searchParams, totalResults });
        finalParams = searchParams;
        finalTotalResults = totalResults;

        if (totalResults > 0) {
          break;
        }
      }

      await updateRun(paramRun.id, "completed", identity);
    } catch (error) {
      await updateRun(paramRun.id, "failed", identity).catch(() => {});
      throw error;
    }

    // Store in cache (upsert — replace expired entries)
    await db
      .insert(apolloSearchParamsCache)
      .values({
        orgId: req.orgId!,
        brandIds,
        brandIdsKey,
        contextHash,
        searchParams: finalParams,
        totalResults: finalTotalResults,
        attempts: attemptHistory.length,
        attemptHistory: attemptHistory as unknown as Record<string, unknown>,
      })
      .onConflictDoUpdate({
        target: [apolloSearchParamsCache.orgId, apolloSearchParamsCache.brandIdsKey, apolloSearchParamsCache.contextHash],
        set: {
          brandIds,
          searchParams: finalParams,
          totalResults: finalTotalResults,
          attempts: attemptHistory.length,
          attemptHistory: attemptHistory as unknown as Record<string, unknown>,
          createdAt: new Date(), // Reset TTL
        },
      });

    res.json({
      searchParams: finalParams,
      totalResults: finalTotalResults,
      attempts: attemptHistory.length,
      attemptHistory,
      cached: false,
    });
  } catch (error) {
    console.error("[Apollo Service][POST /search/params] ERROR:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

export default router;
