-- Org-less "company behind a domain" + "person's role" lookups, platform-billed.
CREATE TABLE IF NOT EXISTS "company_domain_lookups" (
	"domain" text PRIMARY KEY NOT NULL,
	"apollo_organization_id" text,
	"raw" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"platform_run_id" text NOT NULL,
	"credits_charged" integer NOT NULL,
	"cost_idempotency_key" text NOT NULL,
	"cost_declared_at" timestamp with time zone,
	"category" text,
	"category_confidence" numeric(6, 5),
	"category_judgment" jsonb,
	"category_judged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "person_role_lookups" (
	"person_key" text PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"matched" boolean NOT NULL,
	"title" text,
	"seniority" text,
	"raw" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"platform_run_id" text NOT NULL,
	"credits_charged" integer NOT NULL,
	"cost_idempotency_key" text NOT NULL,
	"cost_declared_at" timestamp with time zone
);
