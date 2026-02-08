-- Backfill existing rows with empty string before adding NOT NULL
ALTER TABLE "apollo_people_searches" ADD COLUMN "app_id" text;
ALTER TABLE "apollo_people_searches" ADD COLUMN "brand_id" text;
ALTER TABLE "apollo_people_searches" ADD COLUMN "campaign_id" text;
UPDATE "apollo_people_searches" SET "app_id" = '', "brand_id" = '', "campaign_id" = '' WHERE "app_id" IS NULL;
ALTER TABLE "apollo_people_searches" ALTER COLUMN "app_id" SET NOT NULL;
ALTER TABLE "apollo_people_searches" ALTER COLUMN "brand_id" SET NOT NULL;
ALTER TABLE "apollo_people_searches" ALTER COLUMN "campaign_id" SET NOT NULL;

ALTER TABLE "apollo_people_enrichments" ADD COLUMN "app_id" text;
ALTER TABLE "apollo_people_enrichments" ADD COLUMN "brand_id" text;
ALTER TABLE "apollo_people_enrichments" ADD COLUMN "campaign_id" text;
UPDATE "apollo_people_enrichments" SET "app_id" = '', "brand_id" = '', "campaign_id" = '' WHERE "app_id" IS NULL;
ALTER TABLE "apollo_people_enrichments" ALTER COLUMN "app_id" SET NOT NULL;
ALTER TABLE "apollo_people_enrichments" ALTER COLUMN "brand_id" SET NOT NULL;
ALTER TABLE "apollo_people_enrichments" ALTER COLUMN "campaign_id" SET NOT NULL;

CREATE INDEX "idx_searches_campaign" ON "apollo_people_searches" USING btree ("campaign_id");
CREATE INDEX "idx_enrichments_campaign" ON "apollo_people_enrichments" USING btree ("campaign_id");
