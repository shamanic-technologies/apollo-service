-- A route_failed where a child ERRORED (fetchinio 429 under 10 concurrent lookups,
-- 2026-10-03) was stored as "profile not readable": 7 engagers were dropped from
-- their audience and cached as not_found for 30 days. Release them both ways so
-- the next serve looks them up again. Only rows whose stored answer carries a
-- child error are touched; a real miss (every child answered) stays.
DELETE FROM "linkedin_engagement_serves" s
WHERE s."status" = 'unresolvable'
  AND EXISTS (
    SELECT 1 FROM "linkedin_profiles" p
    WHERE p."profile_id" = s."profile_id"
      AND p."status" = 'not_found'
      AND p."raw"::text LIKE '%"outcome": "error"%'
  );--> statement-breakpoint
DELETE FROM "linkedin_profiles"
WHERE "status" = 'not_found'
  AND "raw"::text LIKE '%"outcome": "error"%';
