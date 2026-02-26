import { Request, Response, NextFunction } from "express";

export interface AuthenticatedRequest extends Request {
  orgId?: string;
}

/**
 * Middleware for internal service calls (no auth - Railway private network)
 */
export async function serviceAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const orgId = req.headers["x-org-id"] as string;

    if (!orgId) {
      return res.status(400).json({ error: "x-org-id header required" });
    }

    req.orgId = orgId;
    next();
  } catch (error) {
    console.error("[Apollo Service] Auth error:", error);
    return res.status(401).json({ error: "Authentication failed" });
  }
}
