-- Drop FK constraints referencing orgs table
ALTER TABLE "apollo_people_searches" DROP CONSTRAINT IF EXISTS "apollo_people_searches_org_id_orgs_id_fk";
--> statement-breakpoint
ALTER TABLE "apollo_people_enrichments" DROP CONSTRAINT IF EXISTS "apollo_people_enrichments_org_id_orgs_id_fk";
--> statement-breakpoint
ALTER TABLE "apollo_search_cursors" DROP CONSTRAINT IF EXISTS "apollo_search_cursors_org_id_orgs_id_fk";
--> statement-breakpoint
-- Drop indexes on clerk tables
DROP INDEX IF EXISTS "idx_orgs_clerk_id";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_users_clerk_id";
--> statement-breakpoint
-- Drop the mapping tables (no longer needed — org IDs come directly from client-service)
DROP TABLE IF EXISTS "orgs";
--> statement-breakpoint
DROP TABLE IF EXISTS "users";
