/**
 * DISABLED 2026-05-28 — Apollo waterfall (third-party vendor email lookup)
 * was disabled because vendor email quality was unreliable and not worth the
 * up-to-20-credit cost. Direct Apollo /people/match only (1 credit per email).
 *
 * To revive:
 * 1. Uncomment the block below.
 * 2. Set `run_waterfall_email: true` in src/lib/apollo-client.ts (3 fns).
 * 3. Uncomment waterfall imports + branches in src/routes/search.ts,
 *    src/routes/match.ts, and the webhook handler in src/routes/webhook.ts.
 * 4. Uncomment `WaterfallTimeoutError` Zod export in src/schemas.ts.
 * 5. Bump the authorize quantity in search.ts + match.ts from `1` back to
 *    `WATERFALL_MAX_CREDITS`.
 * 6. Un-skip the waterfall test suites (describe.skip → describe).
 * 7. Update CLAUDE.md banner above "Waterfall enrichment — canonical pattern".
 *
 * See CLAUDE.md > "Waterfall enrichment — canonical pattern" for the full
 * flow that was in place before disabling.
 */

/*
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { apolloPeopleEnrichments } from "../db/schema.js";
import { addCosts, updateCostStatus, type IdentityHeaders } from "./runs-client.js";
import { traceEvent } from "./trace-event.js";

export const WATERFALL_MAX_CREDITS = 20;

export function getWaterfallPollIntervalMs(): number {
  return Number(process.env.WATERFALL_POLL_INTERVAL_MS) || 3_000;
}

export function getWaterfallPollTimeoutMs(): number {
  return Number(process.env.WATERFALL_POLL_TIMEOUT_MS) || 60_000;
}

export async function pollForWaterfallEmail(
  enrichmentId: string,
  timeoutMs: number = getWaterfallPollTimeoutMs(),
  intervalMs: number = getWaterfallPollIntervalMs(),
): Promise<{ record: typeof apolloPeopleEnrichments.$inferSelect | null; resolved: boolean }> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));

    const [record] = await db
      .select()
      .from(apolloPeopleEnrichments)
      .where(eq(apolloPeopleEnrichments.id, enrichmentId))
      .limit(1);

    if (!record) return { record: null, resolved: false };

    if (record.email) return { record, resolved: true };

    if (record.waterfallStatus === "failed" || record.waterfallStatus === "completed") {
      return { record: null, resolved: true };
    }
  }

  return { record: null, resolved: false };
}

export async function provisionWaterfallCost(
  runId: string,
  keySource: "platform" | "org",
  identity: IdentityHeaders,
): Promise<string | null> {
  const { costs } = await addCosts(
    runId,
    [{ costName: "apollo-credit", costSource: keySource, quantity: WATERFALL_MAX_CREDITS, status: "provisioned" }],
    identity,
  );
  return costs[0]?.id ?? null;
}

export async function expireStalePendingWaterfall(
  record: typeof apolloPeopleEnrichments.$inferSelect,
): Promise<void> {
  console.error(`[apollo-service] Waterfall TTL expired: enrichment ${record.id} still pending after 24h (waterfallRequestId=${record.waterfallRequestId})`);

  const cleanupIdentity: IdentityHeaders = {
    orgId: record.orgId,
    brandIds: record.brandIds ?? undefined,
    campaignId: record.campaignId,
  };

  if (record.provisionedCostId && record.enrichmentRunId) {
    await updateCostStatus(record.enrichmentRunId, record.provisionedCostId, "cancelled", cleanupIdentity);
    await addCosts(
      record.enrichmentRunId,
      [{ costName: "apollo-credit", costSource: (record.keySource as "platform" | "org") ?? "platform", quantity: WATERFALL_MAX_CREDITS, status: "actual" }],
      cleanupIdentity,
    );
  }

  if (record.enrichmentRunId) {
    traceEvent(
      record.enrichmentRunId,
      {
        service: "apollo-service",
        event: "waterfall-expired",
        detail: `enrichmentId=${record.id}, waterfallRequestId=${record.waterfallRequestId}, worstCaseCredits=${WATERFALL_MAX_CREDITS}`,
        level: "error",
        data: { enrichmentId: record.id, waterfallRequestId: record.waterfallRequestId, worstCaseCredits: WATERFALL_MAX_CREDITS },
      },
      { "x-org-id": record.orgId },
    ).catch(() => {});
  }

  await db
    .update(apolloPeopleEnrichments)
    .set({ waterfallStatus: "expired" })
    .where(eq(apolloPeopleEnrichments.id, record.id));
}
*/
