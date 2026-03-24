ALTER TABLE "apollo_people_searches" ADD COLUMN "feature_slug" text;--> statement-breakpoint
ALTER TABLE "apollo_people_enrichments" ADD COLUMN "feature_slug" text;--> statement-breakpoint
ALTER TABLE "apollo_search_cursors" ADD COLUMN "feature_slug" text;--> statement-breakpoint
CREATE INDEX "idx_searches_feature_slug" ON "apollo_people_searches" USING btree ("feature_slug");--> statement-breakpoint
CREATE INDEX "idx_enrichments_feature_slug" ON "apollo_people_enrichments" USING btree ("feature_slug");
