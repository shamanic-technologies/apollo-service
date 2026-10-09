-- Apollo through treg while our own Apollo credits are out (apollo-reveal-route.ts).
-- A cached org-less lookup declares its cost later: it must remember WHICH cost
-- (NULL = apollo-credit, as every row before this; 'treg-micro-usd' = treg's charge).
ALTER TABLE "company_domain_lookups" ADD COLUMN IF NOT EXISTS "cost_name" text;
--> statement-breakpoint
ALTER TABLE "person_role_lookups" ADD COLUMN IF NOT EXISTS "cost_name" text;
--> statement-breakpoint
-- A phone reveal answered through treg: its async Apollo callback must not declare
-- Apollo credits we did not spend (NULL = our own Apollo key).
ALTER TABLE "apollo_phone_reveals" ADD COLUMN IF NOT EXISTS "reveal_route" text;
