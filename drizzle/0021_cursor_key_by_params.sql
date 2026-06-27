ALTER TABLE "apollo_search_cursors" ADD COLUMN IF NOT EXISTS "params_hash" text GENERATED ALWAYS AS (md5(search_params::text)) STORED;--> statement-breakpoint
DROP INDEX IF EXISTS "idx_cursors_org_campaign";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_cursors_org_campaign_params" ON "apollo_search_cursors" USING btree ("org_id","campaign_id","params_hash");
