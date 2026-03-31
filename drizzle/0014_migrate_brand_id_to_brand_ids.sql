-- Migrate brand_id (text) to brand_ids (text[]) across all tables

-- apollo_people_searches
ALTER TABLE "apollo_people_searches" ADD COLUMN "brand_ids" text[];
UPDATE "apollo_people_searches" SET "brand_ids" = ARRAY["brand_id"];
ALTER TABLE "apollo_people_searches" ALTER COLUMN "brand_ids" SET NOT NULL;
ALTER TABLE "apollo_people_searches" DROP COLUMN "brand_id";
CREATE INDEX "idx_searches_brand_ids" ON "apollo_people_searches" USING gin ("brand_ids");

-- apollo_people_enrichments
ALTER TABLE "apollo_people_enrichments" ADD COLUMN "brand_ids" text[];
UPDATE "apollo_people_enrichments" SET "brand_ids" = ARRAY["brand_id"];
ALTER TABLE "apollo_people_enrichments" ALTER COLUMN "brand_ids" SET NOT NULL;
ALTER TABLE "apollo_people_enrichments" DROP COLUMN "brand_id";
CREATE INDEX "idx_enrichments_brand_ids" ON "apollo_people_enrichments" USING gin ("brand_ids");

-- apollo_search_cursors
ALTER TABLE "apollo_search_cursors" ADD COLUMN "brand_ids" text[];
UPDATE "apollo_search_cursors" SET "brand_ids" = ARRAY["brand_id"];
ALTER TABLE "apollo_search_cursors" ALTER COLUMN "brand_ids" SET NOT NULL;
ALTER TABLE "apollo_search_cursors" DROP COLUMN "brand_id";

-- apollo_search_params_cache
DROP INDEX "idx_params_cache_lookup";
ALTER TABLE "apollo_search_params_cache" ADD COLUMN "brand_ids" text[];
ALTER TABLE "apollo_search_params_cache" ADD COLUMN "brand_ids_key" text;
UPDATE "apollo_search_params_cache" SET "brand_ids" = ARRAY["brand_id"], "brand_ids_key" = "brand_id";
ALTER TABLE "apollo_search_params_cache" ALTER COLUMN "brand_ids" SET NOT NULL;
ALTER TABLE "apollo_search_params_cache" ALTER COLUMN "brand_ids_key" SET NOT NULL;
ALTER TABLE "apollo_search_params_cache" DROP COLUMN "brand_id";
CREATE UNIQUE INDEX "idx_params_cache_lookup" ON "apollo_search_params_cache" ("org_id", "brand_ids_key", "context_hash");
