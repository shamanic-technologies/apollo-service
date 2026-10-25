/**
 * LEDGER-RESIDUAL-1025: a run of ours marked SUPPORT whose output production later
 * REUSED is not support-only. 2026-10-23 we marked 891 runs staff_experiment (staff
 * runs hung under two postmark email-send runs of distribute.you); some of their
 * checks/finds were real prospects' addresses, and later sends reused those verdicts
 * (30-day reuse declares nothing), so the sends consumed email_checked / email_found
 * with NO producer: our backfill rows for those runs were refused `run_marked_support`.
 *
 * The caller passes the runs (evidence = a no-producer consumption of that
 * person's lead after the run, read from the ledger: never inferred here); we undo
 * their mark through runs-service's OWNER door, then re-open our refused declaration
 * rows on exactly those runs so the declarer declares them like any past outcome.
 * Pure staff probes are never passed and stay marked. dryRun previews only.
 */
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { outcomeDeclarations } from "../db/schema.js";
import {
  applyOwnSupportUnmarks,
  previewOwnSupportUnmarks,
  type SupportUnmarkPreview,
  type SupportUnmarkResult,
} from "./runs-client.js";
import { MARKED_BY } from "./support-marks.js";

export const REFUSED_SUPPORT_ERROR = "%run_marked_support%";

export interface UnmarkReport {
  dryRun: boolean;
  preview: SupportUnmarkPreview;
  applied: SupportUnmarkResult | null;
  /** Our declaration rows on those runs refused as support: re-opened (or that would be, on a dry run). */
  reopened: number;
}

const refusedOn = (runIds: string[]) =>
  and(
    inArray(outcomeDeclarations.runId, runIds),
    eq(outcomeDeclarations.status, "abandoned"),
    like(outcomeDeclarations.lastError, REFUSED_SUPPORT_ERROR)
  );

export async function unmarkReusedSupportRuns(opts: { dryRun: boolean; runIds: string[]; reason: string }): Promise<UnmarkReport> {
  const body = { reason: opts.reason, unmarkedBy: MARKED_BY, runIds: opts.runIds };
  const preview = await previewOwnSupportUnmarks(body);
  if (opts.dryRun) {
    const [row] = (await db.select({ n: sql<number>`count(*)::int` }).from(outcomeDeclarations).where(refusedOn(opts.runIds))) as Array<{ n: number }>;
    return { dryRun: true, preview, applied: null, reopened: Number(row?.n ?? 0) };
  }
  // Unmark first: a re-opened row on a still-marked run would only be refused again.
  const applied = await applyOwnSupportUnmarks(body);
  const reopenedRows = await db
    .update(outcomeDeclarations)
    .set({ status: "pending", attempts: 0, lastError: null, nextAttemptAt: new Date() })
    .where(refusedOn(opts.runIds))
    .returning({ id: outcomeDeclarations.id });
  return { dryRun: false, preview, applied, reopened: reopenedRows.length };
}
