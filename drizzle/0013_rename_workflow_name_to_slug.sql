ALTER TABLE "apollo_people_searches" RENAME COLUMN "workflow_name" TO "workflow_slug";
ALTER TABLE "apollo_people_enrichments" RENAME COLUMN "workflow_name" TO "workflow_slug";
ALTER TABLE "apollo_search_cursors" RENAME COLUMN "workflow_name" TO "workflow_slug";
