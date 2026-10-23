import { errorMessage } from "../lib/db-error.js";
import { Router } from "express";
import { z } from "zod";
import { serviceAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { verifyEmailBatch, EmailVerificationError, MAX_VERIFY_BATCH, normalizeEmail } from "../lib/email-verification.js";
import type { NamedSubject } from "../lib/outcome-declarations.js";
import { emailVerificationErrorResponse } from "../lib/email-verification-response.js";
import type { IdentityHeaders } from "../lib/runs-client.js";

const router = Router();

export const VerifyEmailsRequestSchema = z.object({
  emails: z.array(z.string().trim().min(1).max(320)).min(1).max(MAX_VERIFY_BATCH),
  source: z.string().trim().min(1).max(100).optional(),
  // COST-ACCOUNTING-1023: who each address IS for the cost ledger, when the caller
  // owns that subject (a mailing-list subscriber is not a lead). Absent = the
  // person's lead in lead-service, resolved later.
  subjects: z
    .array(
      z.object({
        email: z.string().trim().min(1).max(320),
        subjectService: z.string().trim().min(1).max(100),
        subjectId: z.string().trim().min(1).max(200),
      })
    )
    .max(MAX_VERIFY_BATCH)
    .optional(),
});

/**
 * POST /email-verifications — verdicts for addresses the caller already holds.
 *
 * Same verifier, bronze table, 30-day reuse and cost protocol as the reveal
 * paths (every verification bills the CALLER's org, as a child run of x-run-id).
 * All or nothing: one address that cannot be verified fails the whole call with
 * 502 {type: "email_verification"}, so no caller ever holds a partial answer.
 */
router.post("/email-verifications", serviceAuth, async (req: AuthenticatedRequest, res) => {
  const parsed = VerifyEmailsRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ type: "validation", error: "Invalid request", details: parsed.error.flatten() });
  }
  const { runId, brandIds, campaignId, audienceId, featureSlug, workflowSlug } = req;
  if (!runId) {
    return res.status(400).json({ type: "validation", error: "x-run-id header required" });
  }
  const identity: IdentityHeaders = { orgId: req.orgId!, userId: req.userId, brandIds, campaignId, audienceId, featureSlug, workflowSlug };
  const tracking = { brandIds, campaignId, audienceId, featureSlug, workflowSlug };
  const source = parsed.data.source ? `verify:${parsed.data.source}` : "verify";

  const emails = new Set(parsed.data.emails.map(normalizeEmail));
  const subjects = new Map<string, NamedSubject>();
  for (const s of parsed.data.subjects ?? []) {
    const email = normalizeEmail(s.email);
    if (!emails.has(email)) {
      return res.status(400).json({ type: "validation", error: `subjects[].email ${s.email} is not in emails` });
    }
    const prior = subjects.get(email);
    if (prior && (prior.subjectService !== s.subjectService || prior.subjectId !== s.subjectId)) {
      return res.status(400).json({ type: "validation", error: `two different subjects for ${s.email}` });
    }
    subjects.set(email, { subjectService: s.subjectService, subjectId: s.subjectId });
  }

  try {
    const results = await verifyEmailBatch(parsed.data.emails, { identity, tracking, runId, source, subjects });
    return res.json({ results });
  } catch (error) {
    console.error(`[Apollo Service][POST /email-verifications] org=${req.orgId} run=${runId} ERROR:`, error);
    if (error instanceof EmailVerificationError) {
      const answer = emailVerificationErrorResponse(error);
      return res.status(answer.status).json(answer.body);
    }
    return res.status(500).json({ type: "internal", error: error instanceof Error ? errorMessage(error) : "Internal server error" });
  }
});

export default router;
