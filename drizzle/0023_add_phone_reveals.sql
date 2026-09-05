CREATE TABLE IF NOT EXISTS "apollo_phone_reveals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text,
	"apollo_person_id" text NOT NULL,
	"run_id" text,
	"reveal_run_id" text,
	"brand_ids" text[],
	"campaign_id" text,
	"audience_id" text,
	"feature_slug" text,
	"workflow_slug" text,
	"apollo_request_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"mobile_phone" text,
	"dnc_status" text,
	"phone_numbers" jsonb,
	"webhook_payload" jsonb,
	"failure_reason" text,
	"key_source" text,
	"provisioned_cost_id" text,
	"credits_consumed" integer,
	"cost_reconciled_at" timestamp with time zone,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_phone_reveals_org_person" ON "apollo_phone_reveals" USING btree ("org_id","apollo_person_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_phone_reveals_request" ON "apollo_phone_reveals" USING btree ("apollo_request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_phone_reveals_status" ON "apollo_phone_reveals" USING btree ("status");
