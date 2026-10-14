import { Router } from "express";
import { requireServiceApiKey } from "./transfer-brand.js";
import { VerificationHistoryQuerySchema } from "../schemas.js";
import { readVerificationHistory, HISTORY_DEFAULT_LIMIT } from "../lib/verification-history.js";

const router = Router();

/**
 * GET /internal/email-verifications/history — every verification ever made, as a
 * resumable feed (cursor = insertion order). A consumer (instantly-service) mirrors
 * it to know which verdict an address had at a past date. Read-only.
 */
router.get("/internal/email-verifications/history", requireServiceApiKey, async (req, res) => {
  const parsed = VerificationHistoryQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ type: "validation", error: "Invalid request", details: parsed.error.flatten() });
  }
  try {
    const page = await readVerificationHistory(parsed.data.after ?? "0", parsed.data.limit ?? HISTORY_DEFAULT_LIMIT);
    res.json(page);
  } catch (error) {
    console.error("[Apollo Service][GET /internal/email-verifications/history] ERROR:", error);
    res.status(500).json({ type: "internal", error: error instanceof Error ? error.message : "Internal server error" });
  }
});

export default router;
