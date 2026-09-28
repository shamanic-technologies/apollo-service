CREATE TABLE IF NOT EXISTS "apollo_organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"raw" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
