-- Remove app_id column from all tables (appId removed from inter-service contract)
ALTER TABLE "apollo_people_searches" DROP COLUMN IF EXISTS "app_id";
--> statement-breakpoint
ALTER TABLE "apollo_people_enrichments" DROP COLUMN IF EXISTS "app_id";
--> statement-breakpoint
ALTER TABLE "apollo_search_cursors" DROP COLUMN IF EXISTS "app_id";
