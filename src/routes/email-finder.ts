import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { emailFindings } from "../db/schema.js";
import { serviceAuth, orgAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { executeEmailFind, toFindingResponse } from "../lib/email-find-run.js";

const router = Router();

export const EmailFindPersonSchema = z.object({
  apolloPersonId: z.string().min(1).optional(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  domain: z.string().min(1).optional(),
  linkedinUrl: z.string().min(1).optional(),
});

export const EmailFindRequestSchema = z
  .object({
    vendor: z.enum(["treg", "explee"]),
    preset: z.enum(["basic", "premium"]).optional(),
    person: EmailFindPersonSchema,
  })
  .superRefine((body, ctx) => {
    const p = body.person;
    const hasName = !!(p.firstName && p.lastName && p.domain);
    if (body.vendor === "explee") {
      if (!body.preset) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["preset"], message: "explee requires preset: basic | premium" });
      if (!hasName) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["person"], message: "explee requires firstName, lastName and domain" });
    } else {
      if (body.preset) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["preset"], message: "treg takes no preset" });
      if (!hasName && !p.linkedinUrl) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["person"], message: "treg requires linkedinUrl, or firstName + lastName + domain" });
      }
    }
  });

/**
 * POST /email-finder/find — ask treg or Explee for a person's work email.
 * See executeEmailFind for the protocol.
 */
router.post("/email-finder/find", serviceAuth, async (req: AuthenticatedRequest, res) => {
  const parsed = EmailFindRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ type: "validation", error: "Invalid request", details: parsed.error.flatten() });
  }
  const { runId, brandIds, campaignId, audienceId, featureSlug, workflowSlug } = req;
  if (!runId) {
    return res.status(400).json({ type: "validation", error: "x-run-id header required" });
  }
  const outcome = await executeEmailFind(
    { orgId: req.orgId!, userId: req.userId, runId, brandIds, campaignId, audienceId, featureSlug, workflowSlug, headers: req.headers, callerPath: "/email-finder/find" },
    parsed.data.vendor,
    parsed.data.preset,
    parsed.data.person
  );
  return res.status(outcome.status).json(outcome.body);
});

/**
 * GET /email-finder/findings?apolloPersonId=… — every finding held for a
 * person, across vendors and presets. Reads silver only; calls no vendor.
 */
router.get("/email-finder/findings", orgAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const apolloPersonId = String(req.query.apolloPersonId ?? "").trim();
    if (!apolloPersonId) {
      return res.status(400).json({ type: "validation", error: "apolloPersonId query param required" });
    }
    const rows = await db.select().from(emailFindings).where(eq(emailFindings.apolloPersonId, apolloPersonId));
    return res.json({ findings: rows.map(toFindingResponse) });
  } catch (error) {
    console.error("[Apollo Service][GET /email-finder/findings] ERROR:", error);
    res.status(500).json({ type: "internal", error: error instanceof Error ? error.message : "Internal server error" });
  }
});

export default router;
