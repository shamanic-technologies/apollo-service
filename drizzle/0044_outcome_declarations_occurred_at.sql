-- COST-BACKFILL-1023: a row parked by the backfill names the instant its source
-- row was produced (enrichment, finding, verification, phone reveal). NULL = parked
-- live by the action itself. A backfilled row is declared through runs-service's
-- batch backfill door with occurredAt = the run's start, never the per-run door.
ALTER TABLE "outcome_declarations" ADD COLUMN IF NOT EXISTS "occurred_at" timestamptz;
