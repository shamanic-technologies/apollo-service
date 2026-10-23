-- Outcome occurrences this service PRODUCED on its own runs, waiting to be
-- declared to runs-service (COST-ACCOUNTING-1023). The subject is the person's
-- lead in lead-service, which does not exist yet when we spend (a lead = a
-- person KEPT after the reveal/verification), so every paid production point
-- parks a row here and the in-process declarer resolves the lead id later
-- (lead-service POST /internal/leads/ids/resolve), then declares. One row per
-- (run, direction, outcome, person). Abandoned after 3 days without a lead:
-- that spend was a loss and rolls into the nearest declaring ancestor run.
CREATE TABLE IF NOT EXISTS "outcome_declarations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" text NOT NULL,
  "direction" text NOT NULL,
  "outcome_key" text NOT NULL,
  "person_key" text NOT NULL,
  "org_id" uuid NOT NULL,
  "brand_ids" text[],
  "campaign_id" text,
  "apollo_person_id" text,
  "email" text,
  "linkedin_url" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "lead_id" text,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "produced_at" timestamp with time zone DEFAULT now() NOT NULL,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "declared_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_outcome_declarations_unique" ON "outcome_declarations" ("run_id", "direction", "outcome_key", "person_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_outcome_declarations_due" ON "outcome_declarations" ("next_attempt_at") WHERE "status" = 'pending';
