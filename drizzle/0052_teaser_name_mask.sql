-- APOLLO-ZERO-COST-1119: keep the free teaser's first name, last-name mask ("Ri***n") and title,
-- so /enrich can unmask the person through free sources before paying an Apollo reveal.
ALTER TABLE apollo_teaser_people ADD COLUMN IF NOT EXISTS first_name text;
--> statement-breakpoint
ALTER TABLE apollo_teaser_people ADD COLUMN IF NOT EXISTS last_name_obfuscated text;
--> statement-breakpoint
ALTER TABLE apollo_teaser_people ADD COLUMN IF NOT EXISTS title text;
