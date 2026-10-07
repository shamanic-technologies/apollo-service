-- Employer NAME -> web domain, resolved through Apollo's FREE organization name
-- lookup (exact name to ONE organization only). Global: a fact about Apollo's
-- data, not about the org that searched, so no org_id (not in transfer-brand).
-- /search/next uses it to put a domain on free teasers; negative outcomes are
-- cached too so a name is not re-looked-up on every page.
CREATE TABLE IF NOT EXISTS "apollo_employer_domains" (
	"organization_name_key" text PRIMARY KEY NOT NULL,
	"organization_name" text NOT NULL,
	"outcome" text NOT NULL,
	"apollo_organization_id" text,
	"domain" text,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL
);
