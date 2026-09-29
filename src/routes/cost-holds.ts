import { Router } from "express";
import { requireServiceApiKey } from "./transfer-brand.js";
import { reconcileStaleHolds, HOLD_STALE_AFTER_MS } from "../lib/hold-reconciler.js";
import { ReconcileHoldsRequestSchema } from "../schemas.js";

const router = Router();

/**
 * POST /internal/cost-holds/reconcile — run one reconciler pass by hand.
 * The same pass runs in-process every RECONCILE_INTERVAL_MS; this route exists
 * so a backfill can be DRY-RUN first (`dryRun: true` writes nothing and returns
 * every per-hold decision with its evidence).
 */
router.post("/internal/cost-holds/reconcile", requireServiceApiKey, async (req, res) => {
  const parsed = ReconcileHoldsRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ type: "validation", error: "Invalid request", details: parsed.error.flatten() });
  }
  try {
    const { dryRun, olderThanMinutes, limit } = parsed.data;
    const report = await reconcileStaleHolds({
      dryRun,
      olderThanMs: olderThanMinutes ? olderThanMinutes * 60_000 : HOLD_STALE_AFTER_MS,
      limit,
    });
    res.json(report);
  } catch (error) {
    console.error("[Apollo Service][POST /internal/cost-holds/reconcile] ERROR:", error);
    res.status(500).json({ type: "internal", error: error instanceof Error ? error.message : "Internal server error" });
  }
});

export default router;
