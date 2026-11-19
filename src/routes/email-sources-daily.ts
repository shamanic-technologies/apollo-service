import { errorMessage } from "../lib/db-error.js";
import { Router } from "express";
import { requireServiceApiKey } from "./transfer-brand.js";
import { EmailSourcesDailyQuerySchema } from "../schemas.js";
import { readEmailSourcesDaily } from "../lib/email-sources-daily.js";

const router = Router();

/** GET /internal/stats/email-sources/daily — where each served work email came from, per day (staff Monitoring). */
router.get("/internal/stats/email-sources/daily", requireServiceApiKey, async (req, res) => {
  const parsed = EmailSourcesDailyQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ type: "validation", error: "Invalid request", details: parsed.error.flatten() });
  }
  try {
    res.json({ days: await readEmailSourcesDaily(parsed.data.days ?? 30) });
  } catch (error) {
    console.error("[Apollo Service][GET /internal/stats/email-sources/daily] ERROR:", error);
    res.status(500).json({ type: "internal", error: error instanceof Error ? errorMessage(error) : "Internal server error" });
  }
});

export default router;
