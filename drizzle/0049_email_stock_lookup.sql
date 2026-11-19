-- APOLLO-ZERO-COST-1119: before a QuickEnrich person's email is bought from treg, /enrich
-- looks for an address a paid task of ours already returned for that LinkedIn person
-- (src/lib/email-stock.ts). Both lookups run on every qe: reveal.
CREATE INDEX IF NOT EXISTS idx_enrichments_linkedin_norm ON apollo_people_enrichments (lower(linkedin_url)) WHERE email IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_email_findings_person_found ON email_findings (person_key) WHERE status = 'found';
