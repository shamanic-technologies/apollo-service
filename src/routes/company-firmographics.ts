import { Router } from "express";
import { requireServiceApiKey } from "./transfer-brand.js";
import { CompanyFirmographicsRequestSchema } from "../schemas.js";
import { lookupFirmographics, toCompanyDomain } from "../lib/company-firmographics.js";

const router = Router();

/**
 * POST /internal/company-firmographics — who the company behind a domain is
 * (country, industry, revenue and headcount ranges, business-model category),
 * and the person's role when a person is given. Org-less and platform-billed:
 * for platform jobs with no org (distribute.you's visit recap). See
 * src/lib/company-firmographics.ts for spend, cache and what each field means.
 */
router.post("/internal/company-firmographics", requireServiceApiKey, async (req, res) => {
  const parsed = CompanyFirmographicsRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ type: "validation", error: "Invalid request", details: parsed.error.flatten() });
  }
  const domain = toCompanyDomain(parsed.data.domain);
  if (!domain) {
    return res.status(400).json({ type: "validation", error: `Not a website domain: ${parsed.data.domain}` });
  }
  try {
    const answer = await lookupFirmographics({
      domain,
      email: parsed.data.email,
      firstName: parsed.data.firstName,
      lastName: parsed.data.lastName,
    });
    res.json(answer);
  } catch (error) {
    console.error("[Apollo Service][POST /internal/company-firmographics] ERROR:", error);
    res.status(502).json({ type: "upstream", error: error instanceof Error ? error.message : "Upstream failure" });
  }
});

export default router;
