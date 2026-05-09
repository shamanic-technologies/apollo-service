/**
 * Shared waterfall enrichment helpers used by /match and /enrich.
 *
 * Apollo's waterfall (third-party email vendors) is async on Apollo's side but
 * synchronous from this service's perspective: callers expect a single response
 * with the email present, definitively absent, or a 504 timeout.
 *
 * See `CLAUDE.md > Waterfall enrichment — canonical pattern` for the full flow.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { apolloPeopleEnrichments } from "../db/schema.js";
import { addCosts, updateCostStatus, type IdentityHeaders } from "./runs-client.js";
import { traceEvent } from "./trace-event.js";

/**
 * Maximum number of Apollo credits a single waterfall request can consume.
 * Used both to authorize/provision upfront and to bill the worst case when a
 * webhook never arrives within the cleanup TTL.
 */
export const WATERFALL_MAX_CREDITS = 20;

export function getWaterfallPollIntervalMs(): number {
  return Number(process.env.WATERFALL_POLL_INTERVAL_MS) || 3_000;
}

export function getWaterfallPollTimeoutMs(): number {
  return Number(process.env.WATERFALL_POLL_TIMEOUT_MS) || 60_000;
}

/**
 * Poll the DB for a waterfall email result.
 * Returns:
 * - { record, resolved: true } if webhook arrived (with or without email)
 * - { record: null, resolved: false } if poll timed out
 */
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

/**
 * Provision the worst-case waterfall cost upfront on the enrichment run.
 * Returns the provisioned cost id (or null if `addCosts` returned nothing).
 *
 * Fail-loud: errors propagate so the caller's request fails and no row is
 * inserted with a missing provisionedCostId.
 */
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

/**
 * Lazy cleanup for a stale `pending` waterfall row whose webhook never
 * arrived within 24h. Cancels the provisioned cost, adds the worst-case
 * actual cost (Apollo charged us, so the org pays), marks the row `expired`,
 * and emits a trace event.
 *
 * Fail-loud: cost reconciliation throws if runs-service is down so the caller
 * retries when it comes back up — the row is only marked `expired` after
 * costs reconcile.
 */
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
