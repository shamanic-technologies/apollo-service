-- linkedin_engagement buying signal: bronze treg calls, silver pages / posts /
-- engagements / profiles, gold per-audience serves (org data).
CREATE TABLE IF NOT EXISTS "linkedin_treg_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint" text NOT NULL,
	"request" jsonb NOT NULL,
	"run_id" text,
	"http_status" integer,
	"response_headers" jsonb,
	"response_body" jsonb,
	"charged_micro" integer,
	"error" text,
	"duration_ms" integer,
	"called_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_linkedin_treg_calls_endpoint" ON "linkedin_treg_calls" ("endpoint", "called_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "linkedin_company_pages" (
	"slug" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"posts_fetched_at" timestamp with time zone,
	"posts_count" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "linkedin_company_posts" (
	"post_id" text PRIMARY KEY NOT NULL,
	"page_slug" text NOT NULL,
	"post_url" text,
	"text" text,
	"published_at" timestamp with time zone,
	"engagement_fetched_at" timestamp with time zone,
	"reactions_seen" integer,
	"comments_seen" integer,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_linkedin_posts_page" ON "linkedin_company_posts" ("page_slug", "published_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "linkedin_post_engagements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" text NOT NULL,
	"page_slug" text NOT NULL,
	"profile_id" text NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"actor_name" text,
	"actor_headline" text,
	"actor_profile_url" text,
	"reaction_type" text,
	"comment_text" text,
	"commented_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_linkedin_engagements_unique" ON "linkedin_post_engagements" ("post_id", "profile_id", "kind", "ref");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_linkedin_engagements_page_profile" ON "linkedin_post_engagements" ("page_slug", "profile_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "linkedin_profiles" (
	"profile_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"public_identifier" text,
	"linkedin_url" text,
	"first_name" text,
	"last_name" text,
	"headline" text,
	"job_title" text,
	"company_name" text,
	"company_slug" text,
	"company_linkedin_url" text,
	"company_website" text,
	"country" text,
	"location" text,
	"raw" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "linkedin_engagement_serves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_ids" text[] NOT NULL,
	"campaign_id" text NOT NULL,
	"audience_key" text NOT NULL,
	"profile_id" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"signal" jsonb NOT NULL,
	"served_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_linkedin_serves_org_audience_profile" ON "linkedin_engagement_serves" ("org_id", "audience_key", "profile_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_linkedin_serves_org_profile" ON "linkedin_engagement_serves" ("org_id", "profile_id");
