-- LEDGER-RESIDUAL-1025-HUMANS: POST /internal/reveal-records/by-person-ids reads every
-- reveal that returned an address (normalized). Without it the lookup seq-scanned the
-- wide table (~9s per 1,000 ids on prod, 2026-10-25).
CREATE INDEX IF NOT EXISTS idx_enrichments_email_norm ON apollo_people_enrichments (lower(btrim(email))) WHERE email IS NOT NULL;
