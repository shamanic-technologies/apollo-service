ALTER TABLE "apollo_people_searches" ADD COLUMN "workflow_name" text;--> statement-breakpoint
ALTER TABLE "apollo_people_enrichments" ADD COLUMN "workflow_name" text;--> statement-breakpoint
ALTER TABLE "apollo_search_cursors" ADD COLUMN "workflow_name" text;
