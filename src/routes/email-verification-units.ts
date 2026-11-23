import { errorMessage } from "../lib/db-error.js";
import { Router } from "express";
import { serviceAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { EmailFoundUnitsQuerySchema } from "../schemas.js";
import { normalizeEmail } from "../lib/email-verification.js";
import { readEmailFoundUnits, UNITS_DEFAULT_LIMIT } from "../lib/email-verification-units.js";

const router = Router();

/**
 * GET /email-verifications/units — the Provider read of outcome email_found
 * (ENGINE-GET-ASK-1123, OpenAPI tag `provider:email_found`, operationId
 * listEmailFoundUnits). Every verdict held for the addresses, newest first, old
 * ones included. Read-only: never calls a verifier, never spends.
 */
router.get("/email-verifications/units", serviceAuth, async (req: AuthenticatedRequest, res) => {
  const parsed = EmailFoundUnitsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ type: "validation", error: "Invalid request", details: parsed.error.flatten() });
  }
  const emails = [...new Set(parsed.data.emails.map(normalizeEmail).filter((e) => e.length > 0))];
  if (emails.length === 0) {
    return res.status(400).json({ type: "validation", error: "emails holds no address" });
  }
  try {
    const page = await readEmailFoundUnits({
      emails,
      since: parsed.data.since ? new Date(parsed.data.since) : undefined,
      decisive: parsed.data.decisive,
      verdicts: parsed.data.verdicts,
      includeFailed: parsed.data.includeFailed ?? false,
      limit: parsed.data.limit ?? UNITS_DEFAULT_LIMIT,
      before: parsed.data.before,
    });
    return res.json(page);
  } catch (error) {
    console.error(`[Apollo Service][GET /email-verifications/units] org=${req.orgId} ERROR:`, error);
    return res.status(500).json({ type: "internal", error: error instanceof Error ? errorMessage(error) : "Internal server error" });
  }
});

export default router;
