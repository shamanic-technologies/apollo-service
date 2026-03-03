import { Request, Response, NextFunction } from "express";

export interface AuthenticatedRequest extends Request {
  orgId?: string;
  userId?: string;
  runId?: string;
  brandId?: string;
  campaignId?: string;
  workflowName?: string;
}

/**
 * Middleware for internal service calls (no auth - Railway private network).
 * Requires x-org-id and x-user-id.
 * Optionally extracts x-run-id, x-brand-id, x-campaign-id, x-workflow-name.
 */
export async function serviceAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const orgId = req.headers["x-org-id"] as string;
    const userId = req.headers["x-user-id"] as string;

    if (!orgId) {
      return res.status(400).json({ error: "x-org-id header required" });
    }

    if (!userId) {
      return res.status(400).json({ error: "x-user-id header required" });
    }

    req.orgId = orgId;
    req.userId = userId;

    // Run context headers (optional at middleware level — routes validate as needed)
    const runId = req.headers["x-run-id"] as string | undefined;
    const brandId = req.headers["x-brand-id"] as string | undefined;
    const campaignId = req.headers["x-campaign-id"] as string | undefined;
    const workflowName = req.headers["x-workflow-name"] as string | undefined;

    if (runId) req.runId = runId;
    if (brandId) req.brandId = brandId;
    if (campaignId) req.campaignId = campaignId;
    if (workflowName) req.workflowName = workflowName;

    next();
  } catch (error) {
    console.error("[Apollo Service] Auth error:", error);
    return res.status(401).json({ error: "Authentication failed" });
  }
}
