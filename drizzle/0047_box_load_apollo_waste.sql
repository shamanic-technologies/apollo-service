-- BOX-LOAD-1028-APOLLO-WASTE.
-- (1) A competitor page every posts provider failed on is remembered for a short
-- backoff (POSTS_FAILED_RETRY_MS) instead of being re-read by every serve: diffco-us
-- drew ~1,000 failed reads an hour (2026-10-27/28, ~1.2 s each, tikhub 400).
ALTER TABLE "linkedin_company_pages" ADD COLUMN IF NOT EXISTS "posts_failed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "linkedin_company_pages" ADD COLUMN IF NOT EXISTS "posts_failure" text;
--> statement-breakpoint
-- (2) POST /internal/acquisition-costs: covering indexes matching each branch's
-- predicate, so a lookup never reads the wide heap (~1.6 s mean per call before,
-- mostly heap reads of apollo_people_enrichments and email_verifications).
CREATE INDEX IF NOT EXISTS idx_enrichments_person_acq ON apollo_people_enrichments (apollo_person_id) INCLUDE (enrichment_run_id, org_id) WHERE enrichment_run_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_enrichments_email_norm_acq ON apollo_people_enrichments (lower(btrim(email))) INCLUDE (enrichment_run_id, org_id) WHERE email IS NOT NULL AND enrichment_run_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_email_verifications_billed_acq ON email_verifications (email) INCLUDE (verify_run_id, org_id) WHERE billed AND verify_run_id IS NOT NULL;
