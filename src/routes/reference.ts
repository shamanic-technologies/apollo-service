import { Router } from "express";
import { serviceAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { getIndustries, getEmployeeRanges } from "../lib/reference-cache.js";

const router = Router();

/**
 * GET /reference/industries - Get Apollo industries list (static)
 */
router.get("/reference/industries", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const industries = getIndustries();
    res.json({ industries });
  } catch (error) {
    console.error("[Apollo Service] Get industries error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

/**
 * GET /reference/employee-ranges - Get employee range options
 */
router.get("/reference/employee-ranges", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const ranges = getEmployeeRanges();
    res.json({ ranges });
  } catch (error) {
    console.error("[Apollo Service] Get employee ranges error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
