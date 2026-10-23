-- A caller can name the subject of an occurrence itself (POST /email-verifications
-- `subjects`, e.g. a transactional-email-service mailing-list subscriber): then
-- subject_service holds that service and lead_id its subject id, no lead-service
-- resolve. NULL = the person's lead in lead-service, resolved by the declarer.
ALTER TABLE "outcome_declarations" ADD COLUMN IF NOT EXISTS "subject_service" text;
