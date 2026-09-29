import { describe, it, expect, vi, beforeEach } from "vitest";

// resolveSignalCohort reads the cursor table: a chainable select whose result each test sets.
let cursorRows: Array<{ searchParams: unknown; exhausted: boolean }> = [];
vi.mock("../../src/db/index.js", () => {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => cursorRows,
  };
  return { db: { select: () => chain } };
});

import {
  materializeBuyingSignal,
  signalConflicts,
  signalWindow,
  addDays,
  daysBetween,
} from "../../src/lib/buying-signal-spec.js";
import {
  deriveEnrichmentSignals,
  hiringSignalsFromPostings,
  pickMatchedSignal,
  resolveSignalCohort,
} from "../../src/lib/buying-signals.js";
import { toApolloSearchParams } from "../../src/lib/transform.js";
import { SearchFiltersSchema, ApolloNativeSearchFiltersSchema } from "../../src/schemas.js";
import { buildFiltersPrompt } from "../../src/lib/filters-prompt.js";

const NOW = new Date("2026-09-29T15:00:00Z");

describe("materializeBuyingSignal", () => {
  it("hiring: job posted in the last N days, narrowed by job titles", () => {
    expect(materializeBuyingSignal({ type: "hiring", window_days: 30, job_titles: ["office manager"] }, NOW)).toEqual({
      organization_job_posted_at_range: { min: "2026-08-30", max: "2026-09-29" },
      q_organization_job_titles: ["office manager"],
    });
  });

  it("funding: latest round inside the window", () => {
    expect(materializeBuyingSignal({ type: "funding", window_days: 90 }, NOW)).toEqual({
      latest_funding_date_range: { min: "2026-07-01", max: "2026-09-29" },
    });
  });

  it("job_change: days in current title, counted back from today", () => {
    expect(materializeBuyingSignal({ type: "job_change", window_days: 90 }, NOW)).toEqual({
      person_days_in_current_title_range: { max: 90 },
    });
  });

  it("a follow-up cohort only covers signals since the previous cohort's day", () => {
    const spec = { type: "funding" as const, window_days: 90, as_of: "2026-09-29", since: "2026-09-25" };
    expect(materializeBuyingSignal(spec, NOW)).toEqual({ latest_funding_date_range: { min: "2026-09-25", max: "2026-09-29" } });
    // job_change served two days after its cohort day: the same people, days re-counted from today
    const jc = { type: "job_change" as const, window_days: 30, as_of: "2026-09-27", since: "2026-09-20" };
    expect(materializeBuyingSignal(jc, NOW)).toEqual({ person_days_in_current_title_range: { min: 2, max: 9 } });
  });

  it("a since older than the window never widens it", () => {
    expect(signalWindow({ type: "hiring", window_days: 30, as_of: "2026-09-29", since: "2026-01-01" }, NOW)).toEqual({
      from: "2026-08-30",
      to: "2026-09-29",
    });
  });

  it("date helpers", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysBetween("2026-08-30", "2026-09-29")).toBe(30);
  });
});

describe("toApolloSearchParams with a buying signal", () => {
  it("keeps the ICP and adds the materialized Apollo filters; the signal key never reaches Apollo", () => {
    const params = toApolloSearchParams(
      { person_titles: ["Owner"], person_locations: ["United States"], buying_signal: { type: "funding", window_days: 30 } },
      NOW,
    );
    expect(params.person_titles).toEqual(["Owner"]);
    expect(params.latest_funding_date_range).toEqual({ min: "2026-08-30", max: "2026-09-29" });
    expect(params).not.toHaveProperty("buying_signal");
  });

  it("refuses an explicit Apollo filter the signal drives (no silent override)", () => {
    const sp = { latest_funding_date_range: { min: "2020-01-01" }, buying_signal: { type: "funding", window_days: 30 } };
    expect(signalConflicts(sp)).toEqual(["latest_funding_date_range"]);
    expect(() => toApolloSearchParams(sp, NOW)).toThrow(/conflicts/);
  });

  it("hiring without job titles leaves an ICP q_organization_job_titles alone", () => {
    const sp = { q_organization_job_titles: ["nurse"], buying_signal: { type: "hiring", window_days: 30 } };
    expect(signalConflicts(sp)).toEqual([]);
    expect(toApolloSearchParams(sp, NOW).q_organization_job_titles).toEqual(["nurse"]);
  });
});

describe("filter schema", () => {
  it("accepts a buying_signal and rejects job_titles on a non-hiring signal", () => {
    expect(SearchFiltersSchema.safeParse({ person_titles: ["CEO"], buying_signal: { type: "hiring", window_days: 30, job_titles: ["cfo"] } }).success).toBe(true);
    expect(SearchFiltersSchema.safeParse({ buying_signal: { type: "funding", window_days: 30, job_titles: ["cfo"] } }).success).toBe(false);
    expect(SearchFiltersSchema.safeParse({ buying_signal: { type: "funding", window_days: 0 } }).success).toBe(false);
  });

  it("is never offered to the refine loop or /search/filters-prompt", () => {
    expect(buildFiltersPrompt(ApolloNativeSearchFiltersSchema)).not.toContain("buying_signal");
  });
});

describe("resolveSignalCohort (rolling cohorts)", () => {
  const icp = { person_titles: ["Owner"], buying_signal: { type: "hiring", window_days: 30 } };
  beforeEach(() => {
    cursorRows = [];
  });

  it("first serve: the whole window, pinned to today", async () => {
    expect(await resolveSignalCohort("org", "camp", icp, NOW)).toEqual({
      person_titles: ["Owner"],
      buying_signal: { type: "hiring", window_days: 30, as_of: "2026-09-29" },
    });
  });

  it("an open cohort keeps being walked, whatever its day", async () => {
    const open = { ...icp, buying_signal: { type: "hiring", window_days: 30, as_of: "2026-09-20" } };
    cursorRows = [{ searchParams: open, exhausted: false }];
    expect(await resolveSignalCohort("org", "camp", icp, NOW)).toEqual(open);
  });

  it("a cohort walked out on an earlier day opens a new one covering only signals since then", async () => {
    cursorRows = [{ searchParams: { ...icp, buying_signal: { type: "hiring", window_days: 30, as_of: "2026-09-20" } }, exhausted: true }];
    expect(await resolveSignalCohort("org", "camp", icp, NOW)).toEqual({
      person_titles: ["Owner"],
      buying_signal: { type: "hiring", window_days: 30, as_of: "2026-09-29", since: "2026-09-20" },
    });
  });

  it("a cohort walked out today stays (done until tomorrow)", async () => {
    const today = { ...icp, buying_signal: { type: "hiring", window_days: 30, as_of: "2026-09-29" } };
    cursorRows = [{ searchParams: today, exhausted: true }];
    expect(await resolveSignalCohort("org", "camp", icp, NOW)).toEqual(today);
  });
});

describe("evidence", () => {
  // Real shapes: a funding event and an employment entry as Apollo's people/match returns them (prod, 2026-09-29).
  const fundingEvent = {
    id: "696603f31cf1c2000185d12c",
    date: "2026-08-12T00:00:00.000+00:00",
    type: "Series A",
    amount: "10M",
    currency: "$",
    news_url: null,
    investors: "Maven 11 Capital",
  };

  it("derives funding and job_change from a fresh enrichment (camelCase employment)", () => {
    const signals = deriveEnrichmentSignals({
      id: "p1",
      organizationId: "o1",
      organizationName: "Acme",
      title: "CEO",
      organizationFundingEvents: [fundingEvent],
      employmentHistory: [{ title: "Head of Sales", organizationName: "Acme", startDate: "2026-08-01", current: true }],
    });
    expect(signals.map((s) => [s.signalType, s.occurredOn, s.fact])).toEqual([
      ["funding", "2026-08-12", "Acme raised a Series A round of $10M on August 12, 2026 (investors: Maven 11 Capital)"],
      ["job_change", "2026-08-01", "Started as Head of Sales at Acme in August 2026"],
    ]);
    expect(signals[0].sourceRef).toBe("696603f31cf1c2000185d12c");
  });

  it("reads the cached (snake_case) employment shape too, and invents nothing without a date", () => {
    const signals = deriveEnrichmentSignals({
      id: "p2",
      organizationId: "o2",
      organizationName: "ADB",
      employmentHistory: [{ id: "e1", title: "Pharmacist", organization_name: "ADB", start_date: null, current: true }],
    });
    expect(signals).toEqual([]);
    const dated = deriveEnrichmentSignals({
      id: "p2",
      organizationId: "o2",
      employmentHistory: [{ id: "e1", title: "Pharmacist", organization_name: "ADB", start_date: "2026-09-01", current: true }],
    });
    expect(dated[0].fact).toBe("Started as Pharmacist at ADB in September 2026");
  });

  it("turns Apollo job postings into dated hiring signals", () => {
    const signals = hiringSignalsFromPostings("o1", "Acme", [
      { id: "j1", title: "Apotheker Apothekerin", url: "https://www.linkedin.com/jobs/view/4469955221/", city: "Volketswil", country: "Switzerland", posted_at: "2026-09-21T18:55:22.000+00:00" },
      { id: "j2", title: "No date", posted_at: null },
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      signalType: "hiring",
      occurredOn: "2026-09-21",
      fact: "Acme posted a job for Apotheker Apothekerin (Volketswil, Switzerland) on September 21, 2026",
      sourceUrl: "https://www.linkedin.com/jobs/view/4469955221/",
    });
  });

  it("picks the in-window signal the cohort matched, preferring a posting that names a wanted role", () => {
    const postings = hiringSignalsFromPostings("o1", "Acme", [
      { id: "a", title: "Nurse", posted_at: "2026-09-25" },
      { id: "b", title: "Office Manager", posted_at: "2026-09-10" },
      { id: "c", title: "Office Manager", posted_at: "2026-06-01" },
    ]);
    const spec = { type: "hiring" as const, window_days: 30, job_titles: ["office manager"], as_of: "2026-09-29" };
    expect(pickMatchedSignal(spec, postings, NOW)?.sourceRef).toBe("b");
    expect(pickMatchedSignal({ type: "hiring", window_days: 30, as_of: "2026-09-29" }, postings, NOW)?.sourceRef).toBe("a");
    expect(pickMatchedSignal({ type: "hiring", window_days: 3, as_of: "2026-09-29" }, postings, NOW)).toBeNull();
  });

  it("job_change tolerates Apollo's month-precision start date", () => {
    const [jc] = deriveEnrichmentSignals({
      id: "p",
      employmentHistory: [{ title: "COO", startDate: "2026-08-01", current: true }],
    });
    // matched by a 30-day window on 09-29: Apollo knew a finer date inside it
    expect(pickMatchedSignal({ type: "job_change", window_days: 30, as_of: "2026-09-29" }, [jc], NOW)).not.toBeNull();
    expect(pickMatchedSignal({ type: "job_change", window_days: 10, as_of: "2026-09-29" }, [jc], NOW)).toBeNull();
  });
});
