import { errorMessage } from "../lib/db-error.js";
import { Router } from "express";
import { requireServiceApiKey } from "./transfer-brand.js";
import { parkHistoricalOutcomes } from "../lib/outcome-backfill.js";
import { markPastSupportRuns } from "../lib/support-marks.js";
import { OutcomeBackfillRequestSchema, SupportMarksBackfillRequestSchema } from "../schemas.js";

const router = Router();

/**
 * POST /internal/outcome-declarations/backfill (COST-BACKFILL-1023) — park the
 * outcomes our PAST runs produced (outcome-backfill.ts); the in-process declarer
 * then declares them on those runs through runs-service's backfill door.
 * `dryRun: true` only counts. Re-running parks nothing already parked.
 */
router.post("/internal/outcome-declarations/backfill", requireServiceApiKey, async (req, res) => {
  const parsed = OutcomeBackfillRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ type: "validation", error: "Invalid request", details: parsed.error.flatten() });
  }
  try {
    res.json(await parkHistoricalOutcomes({ dryRun: parsed.data.dryRun }));
  } catch (error) {
    console.error("[Apollo Service][POST /internal/outcome-declarations/backfill] ERROR:", error);
    res.status(500).json({ type: "internal", error: errorMessage(error) });
  }
});

/**
 * POST /internal/support-marks/backfill (COST-SUPPORT-1024) — mark our past runs
 * that produce no outcome by design as SUPPORT (support-marks.ts). `dryRun: true`
 * only previews. A mark is final and idempotent: a re-run marks nothing twice.
 */
router.post("/internal/support-marks/backfill", requireServiceApiKey, async (req, res) => {
  const parsed = SupportMarksBackfillRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ type: "validation", error: "Invalid request", details: parsed.error.flatten() });
  }
  try {
    res.json({ dryRun: parsed.data.dryRun, steps: await markPastSupportRuns(parsed.data) });
  } catch (error) {
    console.error("[Apollo Service][POST /internal/support-marks/backfill] ERROR:", error);
    res.status(500).json({ type: "internal", error: errorMessage(error) });
  }
});

export default router;
