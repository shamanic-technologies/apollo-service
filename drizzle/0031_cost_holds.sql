-- Ledger of every provisioned cost hold this service opens in runs-service, so
-- a hold its request never closed (crash, deploy swap, failed cleanup) is found
-- and settled from evidence instead of sitting provisioned forever.
CREATE TABLE IF NOT EXISTS "cost_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cost_id" text NOT NULL,
	"run_id" text NOT NULL,
	"cost_name" text NOT NULL,
	"cost_source" text NOT NULL,
	"quantity" numeric(20, 6) NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text,
	"brand_ids" text[],
	"campaign_id" text,
	"audience_id" text,
	"feature_slug" text,
	"workflow_slug" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_status" text,
	"settled_by" text,
	"settlement_reason" text,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_cost_holds_cost" ON "cost_holds" ("cost_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cost_holds_unsettled" ON "cost_holds" ("created_at") WHERE settled_at IS NULL;
