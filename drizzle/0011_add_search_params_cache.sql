CREATE TABLE "apollo_search_params_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" text NOT NULL,
	"context_hash" text NOT NULL,
	"search_params" jsonb NOT NULL,
	"total_results" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"attempt_history" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_params_cache_lookup" ON "apollo_search_params_cache" USING btree ("org_id","brand_id","context_hash");
