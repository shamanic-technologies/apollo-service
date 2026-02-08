import { Router } from "express";
import { serviceAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { validateBatch } from "../lib/validators.js";
import { ValidateRequestSchema } from "../schemas.js";

const router = Router();

/**
 * POST /validate - Validate a batch of items against Apollo's expected format.
 */
router.post("/validate", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const parsed = ValidateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    }
    const { endpoint, items } = parsed.data;

    const results = validateBatch(endpoint, items);

    res.json({ results });
  } catch (error) {
    console.error("[Apollo Service] Validation error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

export default router;
