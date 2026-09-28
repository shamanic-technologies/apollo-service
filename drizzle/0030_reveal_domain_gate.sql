-- Reveal domain gate: who an Apollo teaser person works for (free, from
-- /search/next), the domain-level index on verdicts, and the ledger of every
-- reveal skipped because its domain cannot pass the deliverability gate.
CREATE TABLE IF NOT EXISTS "apollo_teaser_people" (
	"apollo_person_id" text PRIMARY KEY NOT NULL,
	"organization_name" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reveal_skips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" text NOT NULL,
	"brand_ids" text[],
	"campaign_id" text,
	"audience_id" text,
	"apollo_person_id" text NOT NULL,
	"organization_name" text,
	"organization_id" text,
	"reason" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_reveal_skips_campaign" ON "reveal_skips" ("campaign_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_reveal_skips_org" ON "reveal_skips" ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_email_verifications_domain_at" ON "email_verifications" (split_part("email", '@', 2), "verified_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_enrichments_organization_id" ON "apollo_people_enrichments" ("organization_id");
--> statement-breakpoint
-- Backfill the employer of every teaser served in the last 14 days, so people
-- already sitting in a consumer's buffer are gated too. Latest name wins.
INSERT INTO "apollo_teaser_people" ("apollo_person_id", "organization_name", "first_seen_at", "last_seen_at")
SELECT DISTINCT ON (p->>'id') p->>'id', trim(p->'organization'->>'name'), s.created_at, s.created_at
FROM "apollo_people_searches" s, jsonb_array_elements(COALESCE(s.response_raw->'people', '[]'::jsonb)) p
WHERE s.created_at > now() - interval '14 days'
  AND p->>'id' IS NOT NULL
  AND length(trim(COALESCE(p->'organization'->>'name', ''))) > 0
ORDER BY p->>'id', s.created_at DESC
ON CONFLICT ("apollo_person_id") DO NOTHING;
