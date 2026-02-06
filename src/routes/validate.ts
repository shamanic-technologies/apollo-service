import { Router } from "express";
import { serviceAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { getByokKey } from "../lib/keys-client.js";
import { validateBatch, EndpointType } from "../lib/validators.js";

const router = Router();

const VALID_ENDPOINTS: EndpointType[] = ["search", "enrich", "bulk-enrich"];

/**
 * POST /validate - Validate a batch of items against Apollo's expected format.
 *
 * Body: {
 *   endpoint: "search" | "enrich" | "bulk-enrich",
 *   items: unknown[]
 * }
 */
router.post("/validate", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { endpoint, items } = req.body;

    if (!endpoint || !VALID_ENDPOINTS.includes(endpoint)) {
      return res.status(400).json({
        error: `endpoint must be one of: ${VALID_ENDPOINTS.join(", ")}`,
      });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items must be a non-empty array" });
    }

    // Get Apollo API key for industry tag validation
    const apiKey = await getByokKey(req.clerkOrgId!, "apollo");

    const results = await validateBatch(endpoint, items, apiKey, req.orgId!);

    res.json({ results });
  } catch (error) {
    console.error("[Apollo Service] Validation error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

export default router;
