ALTER TABLE "apollo_audiences" ADD COLUMN IF NOT EXISTS "serve_source" text DEFAULT 'apollo' NOT NULL;--> statement-breakpoint
ALTER TABLE "apollo_search_cursors" ADD COLUMN IF NOT EXISTS "quickenrich_cursor" text;--> statement-breakpoint
ALTER TABLE "apollo_search_cursors" ADD COLUMN IF NOT EXISTS "quickenrich_pages" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "apollo_search_cursors" ADD COLUMN IF NOT EXISTS "quickenrich_exhausted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quickenrich_searches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" text,
	"campaign_id" text,
	"cursor_id" uuid,
	"apollo_audience_id" uuid,
	"request_body" jsonb NOT NULL,
	"http_status" integer,
	"response_headers" jsonb,
	"response_body" jsonb,
	"charged_micro" integer,
	"rows_returned" integer,
	"rows_kept" integer,
	"error" text,
	"duration_ms" integer,
	"called_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_quickenrich_searches_cursor" ON "quickenrich_searches" USING btree ("cursor_id","called_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quickenrich_people" (
	"emp_id" text PRIMARY KEY NOT NULL,
	"first_name" text,
	"last_name" text,
	"title" text,
	"linkedin_url" text,
	"company_domain" text,
	"company_name" text,
	"locality" text,
	"raw" jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
