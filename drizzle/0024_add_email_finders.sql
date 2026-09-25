CREATE TABLE IF NOT EXISTS "email_finder_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"finding_id" uuid NOT NULL,
	"vendor" text NOT NULL,
	"preset" text NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text,
	"run_id" text,
	"find_run_id" text,
	"request_url" text NOT NULL,
	"request_body" jsonb NOT NULL,
	"http_status" integer,
	"response_headers" jsonb,
	"response_body" jsonb,
	"underlying_provider" text,
	"charged_quantity" numeric(20, 6),
	"charged_unit" text,
	"error" text,
	"duration_ms" integer,
	"called_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_email_finder_calls_finding" ON "email_finder_calls" USING btree ("finding_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_email_finder_calls_vendor_called" ON "email_finder_calls" USING btree ("vendor","called_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor" text NOT NULL,
	"preset" text NOT NULL,
	"person_key" text NOT NULL,
	"apollo_person_id" text,
	"first_name" text,
	"last_name" text,
	"domain" text,
	"linkedin_url" text,
	"org_id" uuid NOT NULL,
	"user_id" text,
	"run_id" text,
	"find_run_id" text,
	"brand_ids" text[],
	"campaign_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"email" text,
	"vendor_mailbox_status" text,
	"mailbox_status" text,
	"underlying_provider" text,
	"cost_name" text NOT NULL,
	"charged_quantity" numeric(20, 6),
	"charged_unit" text,
	"key_source" text,
	"provisioned_cost_id" text,
	"actual_cost_id" text,
	"last_call_id" uuid,
	"failure_reason" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_email_findings_vendor_preset_person" ON "email_findings" USING btree ("vendor","preset","person_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_email_findings_apollo_person" ON "email_findings" USING btree ("apollo_person_id");
