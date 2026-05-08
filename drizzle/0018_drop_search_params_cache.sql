-- Drop the LLM-generated search params cache. The /search/params endpoint
-- has been removed; lead-service now drives strategy generation via
-- Gemini Pro and uses /search/dry-run instead. The cache table has no
-- remaining writers or readers.
DROP INDEX IF EXISTS "idx_params_cache_lookup";
--> statement-breakpoint
DROP TABLE IF EXISTS "apollo_search_params_cache";
