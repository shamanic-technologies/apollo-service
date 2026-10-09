/**
 * Settles the cost holds a request opened and never closed.
 *
 * Every path that provisions a hold closes it itself (actual on a paid call,
 * cancelled otherwise). The ones that stay open are the requests that died
 * before they could: a crash, a deploy swapping the container mid-call, a
 * cleanup call that failed. Billing counts an open hold against the customer's
 * balance, so each one is settled here, decided per hold from what the call
 * actually did, never blanket:
 *
 *   - the hold was already closed in runs-service → just record it
 *   - the run already carries the real charge (`actual`, same cost name) → the
 *     hold is a leftover reservation: cancel it
 *   - verify-email: our bronze row says BounceVerify billed → the hold becomes
 *     the charge (quantity 1 is exact); otherwise cancel
 *   - email-find: our bronze call row carries the vendor's reported charge →
 *     post that as actual, cancel the hold; otherwise cancel
 *   - phone-reveal: Apollo delivers by webhook, so only after PHONE_GRACE_MS;
 *     the reveal row's `creditsConsumed` decides, a reveal still pending means
 *     Apollo never delivered (cancel, and mark the row so a very late webhook
 *     does not settle the cost a second time)
 *   - anything else, or no evidence of a charge → cancel. The customer gets the
 *     benefit of the doubt: we charge only what we can show was spent.
 *
 * Then a run still `running` is closed: completed if it carries an actual
 * charge, failed otherwise. Runs in one pass run sequentially; a failure on one
 * hold is logged and left for the next pass, never marked settled.
 */
import { and, asc, desc, eq, gt, isNull, lt } from "drizzle-orm";
import { db } from "../db/index.js";
import { apolloPhoneReveals, costHolds, emailFinderCalls, emailVerifications, type CostHold } from "../db/schema.js";
import { addCosts, getRun, updateCostStatus, updateRun, type IdentityHeaders, type RunCost } from "./runs-client.js";
import { recordSettledHold } from "./cost-hold-ledger.js";
import { PHONE_REVEAL_MAX_CREDITS } from "./phone-reveal.js";

/** A hold younger than this may belong to a request still in flight. The longest request is ~4 min. */
export const HOLD_STALE_AFTER_MS = 60 * 60 * 1000;
/** Apollo delivers a phone reveal by webhook minutes later; give it a day before judging. */
export const PHONE_GRACE_MS = 24 * 60 * 60 * 1000;
/** How often the in-process sweep runs. This interval IS the bound on how long a leaked hold weighs on a balance. */
export const RECONCILE_INTERVAL_MS = 10 * 60 * 1000;
const BATCH = 200;

export type HoldDecision =
  | { kind: "already_settled"; status: "actual" | "cancelled" | "refunded"; reason: string }
  | { kind: "cancel"; reason: string }
  | { kind: "actualize"; reason: string }
  | { kind: "replace"; quantity: number; reason: string }
  | { kind: "wait"; reason: string };

export interface HoldEvidence {
  /** Hold's current row in runs-service, if found on the run. */
  cost: RunCost | undefined;
  runTaskName: string;
  runCosts: RunCost[];
  ageMs: number;
  /** verify-email: our bronze row for this run says BounceVerify billed. */
  verificationBilled?: boolean;
  /** email-find: the largest charge the vendor reported on this run's calls, in the cost's unit. */
  findCharged?: number | null;
  /** phone-reveal: the reveal row holding this hold, if any. */
  phoneReveal?: { status: string; creditsConsumed: number | null; costReconciledAt: Date | null; revealRoute?: string | null } | null;
}

/** Pure: what to do with one open hold, given what the call left behind. */
export function decideHold(hold: Pick<CostHold, "costId" | "costName">, ev: HoldEvidence): HoldDecision {
  if (!ev.cost) return { kind: "cancel", reason: "hold not found on its run" };
  if (ev.cost.status && ev.cost.status !== "provisioned") {
    return { kind: "already_settled", status: ev.cost.status, reason: `already ${ev.cost.status} in runs-service` };
  }

  if (ev.runTaskName === "phone-reveal") {
    if (ev.ageMs < PHONE_GRACE_MS) return { kind: "wait", reason: "phone reveal inside its webhook grace period" };
    const r = ev.phoneReveal;
    if (!r || r.status === "pending") return { kind: "cancel", reason: "Apollo never delivered the phone reveal" };
    // Answered through treg: treg's charge was declared at the call, we spent no Apollo credit.
    if (r.revealRoute === "treg") return { kind: "cancel", reason: "phone reveal answered through treg, its charge is already declared" };
    const credits = r.creditsConsumed ?? 0;
    if (credits <= 0) return { kind: "cancel", reason: `phone reveal ${r.status}, Apollo charged nothing` };
    if (credits === PHONE_REVEAL_MAX_CREDITS) return { kind: "actualize", reason: `Apollo charged ${credits} credits for the reveal` };
    return { kind: "replace", quantity: credits, reason: `Apollo charged ${credits} credits for the reveal` };
  }

  const declared = ev.runCosts.some((c) => c.id !== hold.costId && c.costName === hold.costName && c.status === "actual");
  if (declared) return { kind: "cancel", reason: "the real charge is already declared on the run" };

  if (ev.runTaskName === "verify-email") {
    return ev.verificationBilled
      ? { kind: "actualize", reason: "BounceVerify returned a decisive (billed) verdict" }
      : { kind: "cancel", reason: "no billed BounceVerify verdict for this run" };
  }

  if (ev.runTaskName.startsWith("email-find-")) {
    return ev.findCharged && ev.findCharged > 0
      ? { kind: "replace", quantity: ev.findCharged, reason: `vendor reported a charge of ${ev.findCharged}` }
      : { kind: "cancel", reason: "the vendor never reported a charge for this run" };
  }

  return { kind: "cancel", reason: "no evidence the reserved call was paid for" };
}

function identityOf(hold: CostHold): IdentityHeaders {
  return {
    orgId: hold.orgId,
    userId: hold.userId ?? undefined,
    brandIds: hold.brandIds ?? undefined,
    campaignId: hold.campaignId ?? undefined,
    audienceId: hold.audienceId ?? undefined,
    featureSlug: hold.featureSlug ?? undefined,
    workflowSlug: hold.workflowSlug ?? undefined,
  };
}

async function gatherEvidence(hold: CostHold, taskName: string, runCosts: RunCost[]): Promise<HoldEvidence> {
  const ev: HoldEvidence = {
    cost: runCosts.find((c) => c.id === hold.costId),
    runTaskName: taskName,
    runCosts,
    ageMs: Date.now() - new Date(hold.createdAt).getTime(),
  };
  if (taskName === "verify-email") {
    const [row] = await db
      .select({ billed: emailVerifications.billed })
      .from(emailVerifications)
      .where(and(eq(emailVerifications.verifyRunId, hold.runId), eq(emailVerifications.billed, true)))
      .limit(1);
    ev.verificationBilled = !!row;
  } else if (taskName.startsWith("email-find-")) {
    const [row] = await db
      .select({ charged: emailFinderCalls.chargedQuantity })
      .from(emailFinderCalls)
      .where(and(eq(emailFinderCalls.findRunId, hold.runId), gt(emailFinderCalls.chargedQuantity, "0")))
      .orderBy(desc(emailFinderCalls.chargedQuantity))
      .limit(1);
    ev.findCharged = row?.charged == null ? null : Number(row.charged);
  } else if (taskName === "phone-reveal") {
    const [row] = await db
      .select({
        status: apolloPhoneReveals.status,
        creditsConsumed: apolloPhoneReveals.creditsConsumed,
        costReconciledAt: apolloPhoneReveals.costReconciledAt,
        revealRoute: apolloPhoneReveals.revealRoute,
      })
      .from(apolloPhoneReveals)
      .where(eq(apolloPhoneReveals.provisionedCostId, hold.costId))
      .limit(1);
    ev.phoneReveal = row ? { ...row, creditsConsumed: row.creditsConsumed == null ? null : Number(row.creditsConsumed) } : null;
  }
  return ev;
}

async function applyDecision(hold: CostHold, d: HoldDecision, identity: IdentityHeaders): Promise<void> {
  if (d.kind === "cancel") {
    await updateCostStatus(hold.runId, hold.costId, "cancelled", identity);
  } else if (d.kind === "actualize") {
    await updateCostStatus(hold.runId, hold.costId, "actual", identity);
  } else if (d.kind === "replace") {
    const source = hold.costSource === "org" ? "org" : "platform";
    await addCosts(hold.runId, [{ costName: hold.costName, costSource: source, quantity: d.quantity, status: "actual" }], identity);
    await updateCostStatus(hold.runId, hold.costId, "cancelled", identity);
  }
  if (d.kind === "wait") return;

  const settled = d.kind === "already_settled" ? d.status : d.kind === "actualize" ? "actual" : "cancelled";
  await recordSettledHold(hold.costId, settled === "actual" ? "actual" : "cancelled", "reconciler", d.reason);

  // A late phone webhook must not settle this cost a second time.
  await db
    .update(apolloPhoneReveals)
    .set({ costReconciledAt: new Date(), updatedAt: new Date() })
    .where(and(eq(apolloPhoneReveals.provisionedCostId, hold.costId), isNull(apolloPhoneReveals.costReconciledAt)));
}

export interface ReconcileItem {
  costId: string;
  runId: string;
  orgId: string;
  costName: string;
  quantity: string;
  taskName: string | null;
  decision: HoldDecision | { kind: "error"; reason: string };
  runClosedAs?: "completed" | "failed";
}

export interface ReconcileReport {
  dryRun: boolean;
  examined: number;
  items: ReconcileItem[];
}

let running: Promise<ReconcileReport> | null = null;

/**
 * One pass over the open holds older than `olderThanMs`. With `dryRun` nothing
 * is written anywhere: every decision is reported instead. Guarded by an
 * in-process mutex held INSIDE the function, so the interval, the internal
 * route and any hand-run can never overlap.
 */
export function reconcileStaleHolds(opts: { dryRun?: boolean; olderThanMs?: number; limit?: number } = {}): Promise<ReconcileReport> {
  if (running) return running;
  running = runPass(opts).finally(() => {
    running = null;
  });
  return running;
}

async function runPass({ dryRun = false, olderThanMs = HOLD_STALE_AFTER_MS, limit = BATCH }: { dryRun?: boolean; olderThanMs?: number; limit?: number }): Promise<ReconcileReport> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const holds = await db
    .select()
    .from(costHolds)
    .where(and(isNull(costHolds.settledAt), lt(costHolds.createdAt, cutoff)))
    .orderBy(asc(costHolds.createdAt))
    .limit(limit);

  const items: ReconcileItem[] = [];
  const closedRuns = new Set<string>();
  const settledThisPass = new Set<string>();
  for (const hold of holds) {
    const base = { costId: hold.costId, runId: hold.runId, orgId: hold.orgId, costName: hold.costName, quantity: String(hold.quantity) };
    const identity = identityOf(hold);
    try {
      const run = await getRun(hold.runId, identity);
      const ev = await gatherEvidence(hold, run.taskName, run.costs ?? []);
      const decision = decideHold(hold, ev);
      const item: ReconcileItem = { ...base, taskName: run.taskName, decision };
      if (!dryRun) await applyDecision(hold, decision, identity);

      if (decision.kind !== "wait") settledThisPass.add(hold.costId);
      if (decision.kind !== "wait" && run.status === "running" && !closedRuns.has(hold.runId)) {
        const stillOpen = (run.costs ?? []).some((c) => c.status === "provisioned" && !settledThisPass.has(c.id));
        if (!stillOpen) {
          const charged =
            decision.kind === "actualize" ||
            decision.kind === "replace" ||
            (decision.kind === "already_settled" && decision.status === "actual") ||
            (run.costs ?? []).some((c) => c.id !== hold.costId && c.status === "actual");
          item.runClosedAs = charged ? "completed" : "failed";
          if (!dryRun) await updateRun(hold.runId, item.runClosedAs, identity);
          closedRuns.add(hold.runId);
        }
      }
      items.push(item);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[Apollo Service] hold_reconciler.failed cost=${hold.costId} run=${hold.runId}: ${reason}`);
      items.push({ ...base, taskName: null, decision: { kind: "error", reason } });
    }
  }

  const tally = items.reduce<Record<string, number>>((acc, i) => ((acc[i.decision.kind] = (acc[i.decision.kind] ?? 0) + 1), acc), {});
  if (holds.length > 0) {
    console.log(`[Apollo Service] hold_reconciler ${dryRun ? "dry-run" : "pass"}: examined=${holds.length} ${JSON.stringify(tally)}`);
  }
  return { dryRun, examined: holds.length, items };
}

/** Arm the periodic sweep. Called once, after `listen`. */
export function startHoldReconciler(): NodeJS.Timeout {
  const tick = () => {
    reconcileStaleHolds().catch((err) => console.error("[Apollo Service] hold_reconciler.pass_failed", err));
  };
  setTimeout(tick, 60_000).unref();
  const timer = setInterval(tick, RECONCILE_INTERVAL_MS);
  timer.unref();
  return timer;
}
