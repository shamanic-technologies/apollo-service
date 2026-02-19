import { Router } from "express";
import { serviceAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { searchPeople } from "../lib/apollo-client.js";
import { getByokKey, getAppKey } from "../lib/keys-client.js";
import { createRun, updateRun, addCosts } from "../lib/runs-client.js";
import { callClaude } from "../lib/anthropic-client.js";
import { getSystemPrompt, buildUserMessage, SearchAttempt } from "../lib/search-params-prompt.js";
import { toApolloSearchParams } from "../lib/transform.js";
import { SearchParamsRequestSchema, SearchFiltersSchema } from "../schemas.js";

const router = Router();

const MAX_ATTEMPTS = 10;

/**
 * POST /search/params — Generate Apollo search parameters from context using LLM.
 * Validates against Apollo and retries with broadened filters if 0 results.
 */
router.post("/search/params", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const parsed = SearchParamsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    }

    const { context, keySource, runId, appId, brandId, campaignId } = parsed.data;

    // Fetch keys — both Apollo and Anthropic use the same source
    const apolloApiKey =
      keySource === "byok"
        ? await getByokKey(req.clerkOrgId!, "apollo")
        : await getAppKey(appId, "apollo");
    const anthropicApiKey =
      keySource === "byok"
        ? await getByokKey(req.clerkOrgId!, "anthropic")
        : await getAppKey(appId, "anthropic");

    // Create child run for cost tracking
    const paramRun = await createRun({
      clerkOrgId: req.clerkOrgId!,
      appId: appId || "mcpfactory",
      brandId,
      campaignId,
      serviceName: "apollo-service",
      taskName: "search-params-generation",
      parentRunId: runId,
    });

    const systemPrompt = getSystemPrompt();
    const attemptHistory: SearchAttempt[] = [];
    let finalParams: Record<string, unknown> = {};
    let finalTotalResults = 0;

    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        // Call LLM
        const userMessage = buildUserMessage(context, attemptHistory);
        const llmResponse = await callClaude(anthropicApiKey, systemPrompt, userMessage);

        // Track LLM token costs
        await addCosts(paramRun.id, [
          { costName: "anthropic-sonnet-4.6-tokens-input", quantity: llmResponse.inputTokens },
          { costName: "anthropic-sonnet-4.6-tokens-output", quantity: llmResponse.outputTokens },
        ]);

        // Parse LLM response as JSON
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

        // Validate against SearchFiltersSchema
        const validated = SearchFiltersSchema.safeParse(rawParams);
        if (!validated.success) {
          console.warn(`[Apollo Service][POST /search/params] Attempt ${attempt}: schema validation failed`, {
            errors: validated.error.flatten(),
          });
          attemptHistory.push({ searchParams: rawParams, totalResults: 0 });
          continue;
        }

        const searchParams = validated.data as Record<string, unknown>;

        // Validate against Apollo — just check the count
        const apolloParams = {
          ...toApolloSearchParams(searchParams),
          page: 1,
          per_page: 1,
        };

        const result = await searchPeople(apolloApiKey, apolloParams);
        const totalResults = result.total_entries ?? result.pagination?.total_entries ?? 0;

        // Track Apollo search credit
        await addCosts(paramRun.id, [{ costName: "apollo-search-credit", quantity: 1 }]);

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

      await updateRun(paramRun.id, "completed");
    } catch (error) {
      await updateRun(paramRun.id, "failed").catch(() => {});
      throw error;
    }

    res.json({
      searchParams: finalParams,
      totalResults: finalTotalResults,
      attempts: attemptHistory.length,
      attemptHistory,
    });
  } catch (error) {
    console.error("[Apollo Service][POST /search/params] ERROR:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

export default router;
