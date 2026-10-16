import { Router } from "express";
import { requireServiceApiKey } from "./transfer-brand.js";
import { AcquisitionCostsRequestSchema } from "../schemas.js";
import { readAcquisitionCosts } from "../lib/acquisition-costs.js";

const router = Router();

/**
 * POST /internal/acquisition-costs — for leads a campaign served, what an EARLIER
 * run (another campaign, or no campaign, before the serve) already paid to find
 * them: Apollo reveal, email find, email verification. Read-only, nothing billed.
 * See src/lib/acquisition-costs.ts.
 */
router.post("/internal/acquisition-costs", requireServiceApiKey, async (req, res) => {
  const parsed = AcquisitionCostsRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ type: "validation", error: "Invalid request", details: parsed.error.flatten() });
  }
  try {
    res.json(await readAcquisitionCosts(parsed.data.orgId, parsed.data.servedLeads));
  } catch (error) {
    console.error("[Apollo Service][POST /internal/acquisition-costs] ERROR:", error);
    res.status(500).json({ type: "internal", error: error instanceof Error ? error.message : "Internal server error" });
  }
});

export default router;
