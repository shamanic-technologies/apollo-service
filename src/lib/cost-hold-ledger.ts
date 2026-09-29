/**
 * Local ledger of the provisioned cost holds this service opens in runs-service.
 *
 * A hold is a pre-call reservation: it must end as `actual` (the call was paid
 * for) or `cancelled` (it was not). Billing counts a hold against the org's
 * balance for as long as it stays `provisioned`, so a hold nobody closes costs
 * the customer money they never spent. The request that opened a hold closes it
 * on every path it can see; what it cannot see is its own death (a crash, a
 * deploy swapping the container mid-call, a cleanup call that itself failed).
 * runs-service has no cross-org listing of open holds, so the only record that
 * survives those is this one. `hold-reconciler.ts` reads it.
 *
 * Written from runs-client (addCosts / updateCostStatus), so no call site can
 * forget: every provisioned cost this service creates lands here.
 */
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { costHolds } from "../db/schema.js";

export interface HoldIdentity {
  orgId: string;
  userId?: string;
  brandIds?: string[];
  campaignId?: string;
  audienceId?: string;
  featureSlug?: string;
  workflowSlug?: string;
}

export interface OpenedHold {
  costId: string;
  runId: string;
  costName: string;
  costSource: string;
  quantity: number | string;
}

export async function recordOpenedHolds(holds: OpenedHold[], identity: HoldIdentity): Promise<void> {
  if (holds.length === 0) return;
  await db
    .insert(costHolds)
    .values(
      holds.map((h) => ({
        costId: h.costId,
        runId: h.runId,
        costName: h.costName,
        costSource: h.costSource,
        quantity: String(h.quantity),
        orgId: identity.orgId,
        userId: identity.userId ?? null,
        brandIds: identity.brandIds ?? null,
        campaignId: identity.campaignId ?? null,
        audienceId: identity.audienceId ?? null,
        featureSlug: identity.featureSlug ?? null,
        workflowSlug: identity.workflowSlug ?? null,
      }))
    )
    .onConflictDoNothing({ target: costHolds.costId });
}

export async function recordSettledHold(
  costId: string,
  status: "actual" | "cancelled",
  settledBy: "request" | "reconciler",
  reason: string | null = null
): Promise<void> {
  await db
    .update(costHolds)
    .set({ settledStatus: status, settledBy, settlementReason: reason, settledAt: new Date() })
    .where(eq(costHolds.costId, costId));
}
