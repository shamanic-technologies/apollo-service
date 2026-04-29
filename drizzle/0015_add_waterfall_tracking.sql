ALTER TABLE "apollo_people_enrichments" ADD COLUMN "waterfall_request_id" text;--> statement-breakpoint
ALTER TABLE "apollo_people_enrichments" ADD COLUMN "waterfall_status" text;--> statement-breakpoint
ALTER TABLE "apollo_people_enrichments" ADD COLUMN "waterfall_source" text;--> statement-breakpoint
ALTER TABLE "apollo_people_enrichments" ADD COLUMN "key_source" text;--> statement-breakpoint
CREATE INDEX "idx_enrichments_waterfall_req" ON "apollo_people_enrichments" USING btree ("waterfall_request_id");
