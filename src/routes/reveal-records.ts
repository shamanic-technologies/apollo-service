import { Router } from "express";
import { errorMessage } from "../lib/db-error.js";
import { requireServiceApiKey } from "./transfer-brand.js";
import { RevealRecordsRequestSchema } from "../schemas.js";
import { findRevealRecords } from "../lib/reveal-records.js";

const router = Router();

/**
 * POST /internal/reveal-records/by-person-ids — what our STORED Apollo reveals
 * returned for a batch of Apollo person ids, both directions (id -> emails,
 * email -> ids). Free, org-less, read-only. See src/lib/reveal-records.ts.
 */
router.post("/internal/reveal-records/by-person-ids", requireServiceApiKey, async (req, res) => {
  const parsed = RevealRecordsRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ type: "validation", error: "Invalid request", details: parsed.error.flatten() });
  }
  try {
    res.json(await findRevealRecords(parsed.data.apolloPersonIds));
  } catch (error) {
    console.error("[Apollo Service][POST /internal/reveal-records/by-person-ids] ERROR:", error);
    res.status(500).json({ type: "internal", error: error instanceof Error ? errorMessage(error) : "Internal error" });
  }
});

export default router;
