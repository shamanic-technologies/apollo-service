/**
 * Runs of ours that produce no outcome BY DESIGN (COST-SUPPORT-1024, owner 2026-10-24).
 *
 * Coverage = declared outcome spend / (ledger - support). A run that produces
 * an outcome declares it (outcome-declarations.ts); a run that never can is
 * marked SUPPORT on runs-service, naming its function, so its spend is reported
 * apart instead of reading as undeclared. Rules, never a cost name:
 *
 * - LIVE: the tasks below are marked at run creation (`support` on POST /v1/runs,
 *   /v1/platform-runs).
 * - PAST: the same tasks plus the retired ones, through runs-service's owner door
 *   by task selection (runs that declared an outcome are left out by runs-service).
 *   Single runs a task rule cannot reach (a staff probe that borrowed a production
 *   run of ours as its x-run-id) are passed by id with their function and reason.
 */
import {
  applyOwnSupportMarks,
  previewOwnSupportMarks,
  type RunSupport,
  type SupportFunction,
  type SupportMarkResult,
  type SupportSelection,
} from "./runs-client.js";

export const MARKED_BY = "apollo-service";

/** Tasks whose every run is support, marked at creation. */
export const LIVE_SUPPORT_TASKS = {
  "audience-companies": {
    kind: "product_feature",
    reason: "Onboarding preview: firmographics of up to 100 companies of an audience, shown to a prospect before any campaign. Builds no outcome of the catalogue.",
  },
  "company-firmographics": {
    kind: "product_feature",
    reason: "Org-less company lookup by domain for the per-visit recap: names the visitor's company, produces no lead.",
  },
  "person-role": {
    kind: "product_feature",
    reason: "Org-less person lookup by email (visit recap role, client-service identity): names a known person, produces no lead.",
  },
} as const satisfies Record<string, RunSupport>;

export type LiveSupportTask = keyof typeof LIVE_SUPPORT_TASKS;

export function supportOf(task: LiveSupportTask): RunSupport {
  return LIVE_SUPPORT_TASKS[task];
}

/**
 * Tasks whose EVERY past run is support: one-off experiments and staff probes. A retired
 * PRODUCTION task (waterfall-enrichment, search-params-generation) is not listed: most of
 * its runs ride the email/lead they helped produce, which a task-wide mark would strip;
 * only its runs riding nothing are passed by id (`runMarks`).
 */
export const PAST_SUPPORT_TASKS: Record<string, RunSupport> = {
  "experiment-treg-people-search": {
    kind: "staff_experiment",
    reason: "One-off treg people-search benchmark (2026-09-26).",
  },
  "issue-249-verification": { kind: "staff_experiment", reason: "Staff check of the refine-loop sample size (#249, 2026-09-01)." },
  "email-find-probe": { kind: "staff_experiment", reason: "Staff probe of the email finders." },
  "linkedin-engagement-probe": { kind: "staff_experiment", reason: "Staff probe of the LinkedIn engagement serve." },
  "staff-verify-probe": { kind: "staff_experiment", reason: "Staff probe of the email verifiers." },
  ...LIVE_SUPPORT_TASKS,
};

export interface RunIdMark {
  kind: SupportFunction;
  reason: string;
  runIds: string[];
}

export type SupportMarkStep =
  | { label: string; kind: SupportFunction; preview: SupportSelection; applied: SupportMarkResult | null };

/**
 * Mark our past support runs. `dryRun` previews every step and writes nothing;
 * otherwise each step is previewed then applied (what preview shows is what apply
 * writes). A step runs-service refuses fails the call loudly; steps already applied
 * stay applied (a mark is final and idempotent, so a re-run is safe).
 */
export async function markPastSupportRuns(opts: { dryRun: boolean; runMarks?: RunIdMark[] }): Promise<SupportMarkStep[]> {
  const steps: Array<{ label: string; body: Parameters<typeof previewOwnSupportMarks>[0] }> = [
    ...Object.entries(PAST_SUPPORT_TASKS).map(([task, s]) => ({
      label: `task:${task}`,
      body: { kind: s.kind, reason: s.reason, markedBy: MARKED_BY, taskNames: [task] },
    })),
    ...(opts.runMarks ?? []).map((m, i) => ({
      label: `runIds:${i}:${m.kind}`,
      body: { kind: m.kind, reason: m.reason, markedBy: MARKED_BY, runIds: m.runIds },
    })),
  ];
  const out: SupportMarkStep[] = [];
  for (const step of steps) {
    const preview = await previewOwnSupportMarks(step.body);
    const applied = opts.dryRun || preview.toMarkCount === 0 ? null : await applyOwnSupportMarks(step.body);
    out.push({ label: step.label, kind: step.body.kind, preview, applied });
  }
  return out;
}
