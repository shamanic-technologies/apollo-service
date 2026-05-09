import { Request, Response, NextFunction } from "express";

export interface AuthenticatedRequest extends Request {
  orgId?: string;
  userId?: string;
  runId?: string;
  brandIds?: string[];
  campaignId?: string;
  featureSlug?: string;
  workflowSlug?: string;
}

/** Parse x-brand-id header as CSV — supports single UUID or comma-separated list. */
export function parseBrandIds(raw: string | undefined): string[] {
  return String(raw ?? "").split(",").map(s => s.trim()).filter(Boolean);
}

/**
 * Middleware for internal service calls (no auth - Railway private network).
 * Requires x-org-id and x-user-id.
 * Optionally extracts x-run-id, x-brand-id, x-campaign-id, x-workflow-slug.
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
      return res.status(400).json({ type: "validation", error: "x-org-id header required" });
    }

    if (!userId) {
      return res.status(400).json({ type: "validation", error: "x-user-id header required" });
    }

    req.orgId = orgId;
    req.userId = userId;

    const runId = req.headers["x-run-id"] as string | undefined;
    const brandIdRaw = req.headers["x-brand-id"] as string | undefined;
    const brandIds = parseBrandIds(brandIdRaw);
    const campaignId = req.headers["x-campaign-id"] as string | undefined;
    const featureSlug = req.headers["x-feature-slug"] as string | undefined;
    const workflowSlug = req.headers["x-workflow-slug"] as string | undefined;

    if (runId) req.runId = runId;
    if (brandIds.length > 0) req.brandIds = brandIds;
    if (campaignId) req.campaignId = campaignId;
    if (featureSlug) req.featureSlug = featureSlug;
    if (workflowSlug) req.workflowSlug = workflowSlug;

    next();
  } catch (error) {
    console.error("[Apollo Service] Auth error:", error);
    return res.status(401).json({ type: "internal", error: "Authentication failed" });
  }
}
