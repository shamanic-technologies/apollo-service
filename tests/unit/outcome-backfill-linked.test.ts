import { describe, it, expect, vi } from "vitest";

/**
 * LEDGER-HISTORY-1024: past linkedin-engagement serves and buying-signal evidence
 * are matched to their run through our own run tree, EXACT single matches only.
 */
vi.mock("../../src/db/index.js", () => ({ db: {} }));
vi.mock("../../src/lib/runs-client.js", () => ({ listRuns: vi.fn() }));

import { matchServesToRuns, matchEvidenceToPersons } from "../../src/lib/outcome-backfill-linked.js";

const run = (id: string, campaignId: string | null, start: string, end: string | null) => ({ id, campaignId, startedAt: start, completedAt: end });
const serve = (campaignId: string, at: string, linkedinUrl: string | null = "https://www.linkedin.com/in/Ada-L/") => ({
  orgId: "org-1", brandIds: ["b-1"], campaignId, servedAt: new Date(at), linkedinUrl,
});

describe("matchServesToRuns", () => {
  const runs = [
    run("r-1", "c-1", "2026-10-04T00:00:00Z", "2026-10-04T00:00:30Z"),
    run("r-2", "c-1", "2026-10-04T00:01:00Z", "2026-10-04T00:01:30Z"),
    run("r-3", "c-2", "2026-10-04T00:00:00Z", "2026-10-04T00:00:30Z"),
    run("r-open", "c-1", "2026-10-04T00:05:00Z", null),
  ];

  it("parks a serve on the one run of its campaign whose window holds it, with the live person key form", () => {
    const m = matchServesToRuns([serve("c-1", "2026-10-04T00:01:10Z")], runs);
    expect(m.parks).toEqual([
      expect.objectContaining({ runId: "r-2", orgId: "org-1", campaignId: "c-1", linkedinUrl: "http://www.linkedin.com/in/ada-l", apolloPersonId: null }),
    ]);
    expect(m).toMatchObject({ rows: 1, unmatched: 0, ambiguous: 0 });
  });

  it("never matches another campaign's run, nor a run with no end", () => {
    const m = matchServesToRuns([serve("c-2", "2026-10-04T00:01:10Z"), serve("c-1", "2026-10-04T00:05:10Z")], runs);
    expect(m.parks).toEqual([]);
    expect(m.unmatched).toBe(2);
  });

  it("skips a serve two concurrent runs could have made", () => {
    const m = matchServesToRuns([serve("c-1", "2026-10-04T00:00:20Z")], [...runs, run("r-4", "c-1", "2026-10-04T00:00:10Z", "2026-10-04T00:00:40Z")]);
    expect(m.parks).toEqual([]);
    expect(m.ambiguous).toBe(1);
  });

  it("skips a served profile with no LinkedIn URL (no subject to name)", () => {
    const m = matchServesToRuns([serve("c-1", "2026-10-04T00:01:10Z", null)], runs);
    expect(m.parks).toEqual([]);
    expect(m.unmatched).toBe(1);
  });
});

describe("matchEvidenceToPersons", () => {
  const fetches = [
    { runId: "ev-1", apolloOrganizationId: "co-1", fetchedAt: new Date("2026-10-12T00:16:50Z") },
    { runId: "ev-2", apolloOrganizationId: "co-2", fetchedAt: new Date("2026-10-12T00:17:00Z") },
  ];
  const person = (callerRunId: string, co: string, id: string) => ({
    callerRunId, apolloOrganizationId: co, apolloPersonId: id, email: " Ada@Co.com ", linkedinUrl: null, brandIds: ["b-1"],
  });

  it("parks lead_identified for the one person enriched under the same caller run at the bought company", () => {
    const m = matchEvidenceToPersons(
      "org-1",
      [{ id: "ev-1", parentRunId: "caller-1", campaignId: "c-1", charged: true }],
      fetches,
      [person("caller-1", "co-1", "p-1"), person("caller-1", "co-9", "p-2"), person("caller-2", "co-1", "p-3")],
    );
    expect(m.parks).toEqual([
      { runId: "ev-1", orgId: "org-1", brandIds: ["b-1"], campaignId: "c-1", apolloPersonId: "p-1", email: "ada@co.com", linkedinUrl: null, occurredAt: fetches[0].fetchedAt },
    ]);
  });

  it("leaves out an uncharged run (live parks only a charged one)", () => {
    const m = matchEvidenceToPersons("org-1", [{ id: "ev-1", parentRunId: "caller-1", campaignId: null, charged: false }], fetches, [person("caller-1", "co-1", "p-1")]);
    expect(m).toMatchObject({ parks: [], rows: 0 });
  });

  it("never picks between two people at the company, nor guesses with none", () => {
    const m = matchEvidenceToPersons(
      "org-1",
      [
        { id: "ev-1", parentRunId: "caller-1", campaignId: null, charged: true },
        { id: "ev-2", parentRunId: "caller-1", campaignId: null, charged: true },
        { id: "ev-3", parentRunId: "caller-1", campaignId: null, charged: true },
      ],
      fetches,
      [person("caller-1", "co-1", "p-1"), person("caller-1", "co-1", "p-2")],
    );
    expect(m.parks).toEqual([]);
    expect(m).toMatchObject({ rows: 3, ambiguous: 1, unmatched: 2 });
  });
});
