CREATE TABLE IF NOT EXISTS "apollo_audiences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text,
	"brand_id" text,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"filters" jsonb NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"count_refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"refine_trace" jsonb,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audiences_org" ON "apollo_audiences" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audiences_brand" ON "apollo_audiences" USING btree ("brand_id");
