-- Insertion-order key for the verification history feed
-- (GET /internal/email-verifications/history). Existing rows are numbered in
-- physical order when the column is added; every later insert takes the next
-- value. The feed pages on seq, never on the random uuid id or verified_at.
ALTER TABLE "email_verifications" ADD COLUMN IF NOT EXISTS "seq" bigserial NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_email_verifications_seq" ON "email_verifications" ("seq");
