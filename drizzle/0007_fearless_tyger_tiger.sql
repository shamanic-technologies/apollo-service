CREATE TABLE IF NOT EXISTS "apollo_search_cursors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"campaign_id" text NOT NULL,
	"app_id" text NOT NULL,
	"brand_id" text NOT NULL,
	"search_params" jsonb NOT NULL,
	"current_page" integer DEFAULT 1 NOT NULL,
	"total_entries" integer DEFAULT 0 NOT NULL,
	"exhausted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "apollo_search_cursors" ADD CONSTRAINT "apollo_search_cursors_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_cursors_org_campaign" ON "apollo_search_cursors" USING btree ("org_id","campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cursors_campaign" ON "apollo_search_cursors" USING btree ("campaign_id");