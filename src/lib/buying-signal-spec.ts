/**
 * The pure half of buying signals (src/lib/buying-signals.ts): the relative
 * spec an audience stores and the Apollo date filters it becomes on a given
 * day. No database, so the filter mapper (transform.ts) can import it.
 */
import type { ApolloSearchParams } from "./apollo-client.js";

/** The three signals Apollo People Search expresses natively. */
export type ApolloBuyingSignalType = "hiring" | "job_change" | "funding";
/**
 * linkedin_engagement is NOT an Apollo search: its people are the engagers of
 * competitor LinkedIn company pages (src/lib/linkedin-engagement.ts).
 */
export type BuyingSignalType = ApolloBuyingSignalType | "linkedin_engagement";

export interface BuyingSignalSpec {
  type: BuyingSignalType;
  window_days: number;
  job_titles?: string[];
  /** linkedin_engagement only: 1-3 competitor LinkedIn company page URLs. */
  competitor_pages?: string[];
  as_of?: string;
  since?: string;
}

/** What /enrich hands downstream so the email writer can reference it. */
/** 1 lead credit per job-postings call that returns postings (measured). */
/** A company's postings are re-bought at most once a week. */
/**
 * Apollo stores many start dates at MONTH precision ("2026-08-01"), while its
 * own days-in-title filter matched on a finer date. A job change whose recorded
 * month starts up to one month before the window is still the one Apollo
 * matched; the fact states the month, which stays true.
 */
/** Apollo fields each signal drives. Setting one alongside the signal is a conflict. */
const SIGNAL_APOLLO_FIELDS: Record<BuyingSignalType, string[]> = {
  hiring: ["organization_job_posted_at_range", "organizationJobPostedAtRange"],
  job_change: ["person_days_in_current_title_range", "personDaysInCurrentTitleRange"],
  funding: ["latest_funding_date_range", "latestFundingDateRange"],
  linkedin_engagement: [],
};

/**
 * A linkedin_engagement audience has no Apollo query: its people come from
 * competitor post engagement, never from People Search. Any Apollo count,
 * dry-run or preview of it is refused by name instead of silently counting
 * the ICP without the signal.
 */
export class SignalNotApolloSearchableError extends Error {
  constructor(public readonly signalType: BuyingSignalType) {
    super(`buying_signal type ${signalType} is not an Apollo People Search filter: it is served from LinkedIn post engagement through /search/next, not counted or previewed on Apollo`);
    this.name = "SignalNotApolloSearchableError";
  }
}

export class BuyingSignalConflictError extends Error {
  constructor(public readonly fields: string[]) {
    super(`buying_signal conflicts with explicit filter(s): ${fields.join(", ")}`);
    this.name = "BuyingSignalConflictError";
  }
}

// ─── Dates (UTC days) ────────────────────────────────────────────────────────

export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return utcDay(d);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function toDay(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(v.trim());
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3] ?? "01"}`;
}

// ─── Spec → Apollo filters ───────────────────────────────────────────────────

export function readSignalSpec(sp: Record<string, unknown>): BuyingSignalSpec | null {
  const raw = sp.buying_signal;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as BuyingSignalSpec;
}

/** Explicit Apollo filters in `sp` that the signal would silently override. */
export function signalConflicts(sp: Record<string, unknown>): string[] {
  const spec = readSignalSpec(sp);
  if (!spec) return [];
  const fields = [...SIGNAL_APOLLO_FIELDS[spec.type]];
  if (spec.type === "hiring" && spec.job_titles?.length) fields.push("q_organization_job_titles", "qOrganizationJobTitles");
  return fields.filter((f) => sp[f] !== undefined && sp[f] !== null);
}

/**
 * The window a spec covers on a given day: `to` is the cohort's day (or today
 * for an un-pinned spec: a count, a dry-run), `from` is `window_days` before it,
 * moved forward to `since` on a follow-up cohort.
 */
export function signalWindow(spec: BuyingSignalSpec, now: Date): { from: string; to: string } {
  const to = spec.as_of ?? utcDay(now);
  const windowStart = addDays(to, -spec.window_days);
  const from = spec.since && spec.since > windowStart ? spec.since : windowStart;
  return { from, to };
}

/** The Apollo filters that express `spec` on `now` (pure). */
export function materializeBuyingSignal(spec: BuyingSignalSpec, now: Date): Partial<ApolloSearchParams> {
  const { from, to } = signalWindow(spec, now);
  switch (spec.type) {
    case "hiring":
      return {
        organization_job_posted_at_range: { min: from, max: to },
        ...(spec.job_titles?.length ? { q_organization_job_titles: spec.job_titles } : {}),
      };
    case "funding":
      return { latest_funding_date_range: { min: from, max: to } };
    case "linkedin_engagement":
      throw new SignalNotApolloSearchableError(spec.type);
    case "job_change": {
      // Apollo counts days in title back from TODAY, not from the cohort day.
      const today = utcDay(now);
      const min = Math.max(0, daysBetween(to, today));
      const max = daysBetween(from, today);
      return { person_days_in_current_title_range: min > 0 ? { min, max } : { max } };
    }
  }
}
