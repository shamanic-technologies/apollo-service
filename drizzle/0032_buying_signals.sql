-- Buying signals: bronze Apollo job-postings calls, silver canonical signals,
-- gold per-campaign record of which signal cohort served a teaser person.
CREATE TABLE IF NOT EXISTS "apollo_job_postings_fetches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"apollo_organization_id" text NOT NULL,
	"run_id" text NOT NULL,
	"postings_count" integer NOT NULL,
	"response_body" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_job_postings_fetches_org" ON "apollo_job_postings_fetches" ("apollo_organization_id", "fetched_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "buying_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signal_type" text NOT NULL,
	"apollo_organization_id" text,
	"apollo_person_id" text,
	"occurred_on" text NOT NULL,
	"fact" text NOT NULL,
	"source" text NOT NULL,
	"source_ref" text NOT NULL,
	"source_url" text,
	"detail" jsonb,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_buying_signals_source" ON "buying_signals" ("signal_type", "source", "source_ref");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_buying_signals_org" ON "buying_signals" ("apollo_organization_id", "signal_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_buying_signals_person" ON "buying_signals" ("apollo_person_id", "signal_type");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "apollo_signal_serves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_ids" text[] NOT NULL,
	"campaign_id" text NOT NULL,
	"cursor_id" uuid NOT NULL,
	"apollo_person_id" text NOT NULL,
	"signal" jsonb NOT NULL,
	"served_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_signal_serves_org_campaign_person" ON "apollo_signal_serves" ("org_id", "campaign_id", "apollo_person_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_signal_serves_org_person" ON "apollo_signal_serves" ("org_id", "apollo_person_id");
