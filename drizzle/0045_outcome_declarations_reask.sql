-- LEDGER-HISTORY-1024: a person not a lead (yet) is re-asked daily, never abandoned
-- (lead-service serves from stock: people revealed weeks earlier became leads later).
UPDATE outcome_declarations
   SET status = 'pending', next_attempt_at = now(), last_error = 'reopened: re-asked daily (LEDGER-HISTORY-1024)'
 WHERE status = 'abandoned' AND lead_id IS NULL
   AND (last_error IS NULL OR last_error LIKE '%no lead of the org%' OR last_error LIKE 'resolve:%');
--> statement-breakpoint
-- A check of an address the caller already held consumed nothing of ours, and a
-- domain-gate probe produces nothing: drop such rows not declared yet.
DELETE FROM outcome_declarations d
 USING email_verifications v
 WHERE v.verify_run_id = d.run_id
   AND d.status IN ('pending', 'abandoned')
   AND ((d.direction = 'consumed' AND v.source LIKE 'verify:%') OR v.source = 'reveal-domain-probe');
