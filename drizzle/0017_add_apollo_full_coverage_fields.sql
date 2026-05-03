ALTER TABLE "apollo_people_enrichments" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "apollo_people_enrichments" ADD COLUMN "personal_emails" jsonb;--> statement-breakpoint
ALTER TABLE "apollo_people_enrichments" ADD COLUMN "mobile_phone" text;--> statement-breakpoint
ALTER TABLE "apollo_people_enrichments" ADD COLUMN "phone_numbers" jsonb;--> statement-breakpoint
ALTER TABLE "apollo_people_enrichments" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "apollo_people_enrichments" ADD COLUMN "organization_raw_address" text;
