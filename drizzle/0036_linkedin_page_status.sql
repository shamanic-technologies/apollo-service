-- A competitor page no posts provider can resolve is remembered as not_found
-- (skipped by every serve until the refresh period re-checks it).
ALTER TABLE "linkedin_company_pages" ADD COLUMN IF NOT EXISTS "posts_status" text;
--> statement-breakpoint
ALTER TABLE "linkedin_company_pages" ADD COLUMN IF NOT EXISTS "posts_error" text;
