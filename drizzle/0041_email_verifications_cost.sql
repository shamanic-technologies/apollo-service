-- Which vendor charge each verification call carried (second opinion + fallback
-- verifiers, 2026-10-17): the cost name declared and the quantity in its unit
-- (apify-bounceverify-email: 1 per billed verdict; treg-micro-usd: treg's
-- X-Treg-Cost-Micro). Null on rows written before this column existed.
ALTER TABLE "email_verifications" ADD COLUMN IF NOT EXISTS "cost_name" text;
--> statement-breakpoint
ALTER TABLE "email_verifications" ADD COLUMN IF NOT EXISTS "cost_quantity" integer;
