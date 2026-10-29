-- FACTORY-P3 next outcomes (email_found): every verification DECISION (which verifier was asked, in which order, what
-- each answered, what was decided) on either path: our own waterfall (`service`) or the stored script while switched
-- (`script`). Bronze, append-only. Read only by GET /internal/email-verification-decisions/recorded (workflow-service's
-- case recorder). Personal data.
CREATE TABLE IF NOT EXISTS "email_verification_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "seq" bigserial NOT NULL,
  "email" text NOT NULL,
  "org_id" uuid NOT NULL,
  "caller_run_id" text,
  "run_id" text,
  "source" text,
  "path" text NOT NULL,
  "held" jsonb,
  "calls" jsonb NOT NULL,
  "result" jsonb,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "email_verification_decisions_path_check" CHECK ("path" IN ('service', 'script'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_email_verification_decisions_seq" ON "email_verification_decisions" ("seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_email_verification_decisions_created" ON "email_verification_decisions" ("created_at");
