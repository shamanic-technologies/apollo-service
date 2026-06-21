ALTER TABLE "apollo_people_searches" ADD COLUMN "audience_id" text;--> statement-breakpoint
ALTER TABLE "apollo_people_enrichments" ADD COLUMN "audience_id" text;--> statement-breakpoint
ALTER TABLE "apollo_search_cursors" ADD COLUMN "audience_id" text;--> statement-breakpoint
CREATE INDEX "idx_searches_audience" ON "apollo_people_searches" USING btree ("audience_id");--> statement-breakpoint
CREATE INDEX "idx_enrichments_audience" ON "apollo_people_enrichments" USING btree ("audience_id");
