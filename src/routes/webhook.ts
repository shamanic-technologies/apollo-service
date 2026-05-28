import { Router, Request, Response } from "express";

const router = Router();

/**
 * POST /webhook/waterfall — DISABLED 2026-05-28.
 *
 * Apollo waterfall (third-party vendor email lookup) was disabled because
 * vendor email quality was unreliable. Direct Apollo /people/match only.
 *
 * Route stays registered as a 200 no-op for ~deploy-window safety: any
 * in-flight waterfall request Apollo dispatched before the deploy may try to
 * deliver a callback here. Returning 200 prevents Apollo's retry storm; the
 * payload is intentionally discarded (no DB update, no cost reconciliation).
 *
 * To revive: restore the original handler body from git history
 * (pre-DIS-68 / pre-2026-05-28) plus the WaterfallVendor /
 * WaterfallPersonPayload / WaterfallWebhookPayload types + safeRequestId
 * helper. See src/lib/waterfall.ts header for the full revive checklist.
 */
router.post("/webhook/waterfall", async (_req: Request, res: Response) => {
  console.log("[Apollo Service][webhook/waterfall] disabled — payload discarded");
  res.status(200).json({ received: true, disabled: true });
});

export default router;
