import { errorMessage } from "../lib/db-error.js";
import { Router } from "express";
import { requireServiceApiKey } from "./transfer-brand.js";
import { parkHistoricalOutcomes } from "../lib/outcome-backfill.js";
import { OutcomeBackfillRequestSchema } from "../schemas.js";

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

export default router;
