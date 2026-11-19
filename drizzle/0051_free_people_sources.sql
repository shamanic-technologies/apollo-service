-- APOLLO-ZERO-COST-1119: free people sources ahead of Apollo (Leadsforge, Dropleads), per
-- filter-set cursor like QuickEnrich. Bronze = every call; silver = one row per person.
ALTER TABLE apollo_search_cursors ADD COLUMN IF NOT EXISTS leadsforge_cursor text;
--> statement-breakpoint
ALTER TABLE apollo_search_cursors ADD COLUMN IF NOT EXISTS leadsforge_pages integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE apollo_search_cursors ADD COLUMN IF NOT EXISTS leadsforge_exhausted boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE apollo_search_cursors ADD COLUMN IF NOT EXISTS dropleads_pages integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE apollo_search_cursors ADD COLUMN IF NOT EXISTS dropleads_exhausted boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS free_source_searches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  run_id text,
  campaign_id text,
  cursor_id uuid,
  apollo_audience_id uuid,
  source text NOT NULL,
  request_body jsonb NOT NULL,
  http_status integer,
  response_body jsonb,
  charged_micro integer,
  rows_returned integer,
  error text,
  duration_ms integer,
  called_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_free_source_searches_cursor ON free_source_searches (cursor_id, called_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS free_source_people (
  source text NOT NULL,
  external_id text NOT NULL,
  first_name text,
  last_name text,
  title text,
  linkedin_url text,
  company_name text,
  company_domain text,
  raw jsonb NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, external_id)
);
