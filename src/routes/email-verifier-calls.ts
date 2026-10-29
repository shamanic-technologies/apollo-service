import { errorMessage } from "../lib/db-error.js";
import { Router } from "express";
import { and, asc, gt, sql } from "drizzle-orm";
import { serviceAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { requireServiceApiKey } from "./transfer-brand.js";
import { doorApifyAvailable, doorVerifierCall } from "../lib/email-verification.js";
import { db } from "../db/index.js";
import { emailVerificationDecisions } from "../db/schema.js";

const router = Router();

const header = (req: AuthenticatedRequest, k: string) => (typeof req.headers[k] === "string" ? (req.headers[k] as string).trim() : "");

/**
 * POST /internal/email-verifier-calls (FACTORY-P3 next outcomes, email_found): the stored verification script's door
 * for ONE verifier call. Serves only a verification in flight here (`x-caller-run-id` = the run that asked this
 * service, + the address): our own call on the script's run (`x-run-id`), with its hold, run, bronze row and
 * email_checked declaration. Answers `{verificationId, verifier, verdict, error}`; 502 = refused (billing, key).
 */
router.post("/internal/email-verifier-calls", requireServiceApiKey, serviceAuth, async (req: AuthenticatedRequest, res) => {
  const callerRunId = header(req, "x-caller-run-id");
  const verifier = typeof req.body?.verifier === "string" ? req.body.verifier : "";
  const email = typeof req.body?.email === "string" ? req.body.email : "";
  if (!callerRunId || !req.runId || !verifier || !email) {
    return res.status(400).json({ type: "validation", error: "x-caller-run-id, x-run-id (the script's run), verifier and email are required" });
  }
  try {
    const out = await doorVerifierCall({ callerRunId, scriptRunId: req.runId, verifier, email });
    return res.status(out.status).json(out.body);
  } catch (error) {
    console.error(`[Apollo Service][POST /internal/email-verifier-calls] ERROR: ${errorMessage(error)}`);
    return res.status(500).json({ type: "internal", error: errorMessage(error) });
  }
});

/** GET /internal/email-verifier-calls/apify?email= — whether BounceVerify is asked now (Apify not out of usage). */
router.get("/internal/email-verifier-calls/apify", requireServiceApiKey, serviceAuth, (req: AuthenticatedRequest, res) => {
  const callerRunId = header(req, "x-caller-run-id");
  const email = typeof req.query.email === "string" ? req.query.email : "";
  if (!callerRunId || !email) return res.status(400).json({ type: "validation", error: "x-caller-run-id and email are required" });
  const out = doorApifyAvailable({ callerRunId, email });
  return res.status(out.status).json(out.body);
});

/**
 * GET /internal/email-verification-decisions/recorded?after=<seq>&limit= — every verification decision, oldest first
 * (cursor = insertion order; a row is served 60 s after it was written, so no lower seq can still commit), for
 * workflow-service's case recorder. Personal data: nothing of it is logged here.
 */
router.get("/internal/email-verification-decisions/recorded", requireServiceApiKey, async (req, res) => {
  const after = req.query.after === undefined ? 0 : Number(req.query.after);
  const limit = req.query.limit === undefined ? 200 : Number(req.query.limit);
  if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
    return res.status(400).json({ type: "validation", error: "after (a seq >= 0) and limit (1..1000) must be integers" });
  }
  try {
    const rows = await db.select().from(emailVerificationDecisions).where(and(gt(emailVerificationDecisions.seq, after), sql`${emailVerificationDecisions.createdAt} < now() - interval '60 seconds'`)).orderBy(asc(emailVerificationDecisions.seq)).limit(limit);
    return res.json({
      decisions: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
      nextAfter: rows.length > 0 ? rows[rows.length - 1].seq : after,
      hasMore: rows.length === limit,
    });
  } catch (error) {
    console.error(`[Apollo Service][GET /internal/email-verification-decisions/recorded] ERROR: ${errorMessage(error)}`);
    return res.status(500).json({ type: "internal", error: errorMessage(error) });
  }
});

export default router;
