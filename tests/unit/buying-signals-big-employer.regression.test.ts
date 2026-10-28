import { describe, it, expect, vi, beforeEach } from "vitest";

// BIG-COMPANY-SIGNALS-1027: a lead at Lloyds Banking (Amazon-sized job postings)
// made /enrich bind ~81,600 parameters in ONE insert into buying_signals and 502.
// The fake db below behaves like postgres: a statement over 65,534 parameters throws.
const PG_MAX = 65_534;
const statements: number[] = [];
const stored = new Map<string, Record<string, unknown>>();
let cachedPostings: unknown[] = [];

function insertChain() {
  let rows: Record<string, unknown>[] = [];
  const chain = {
    values(v: Record<string, unknown>[] | Record<string, unknown>) {
      rows = Array.isArray(v) ? v : [v];
      return chain;
    },
    async onConflictDoUpdate() {
      const params = rows.reduce((n, r) => n + Object.keys(r).length + 1, 0);
      if (params > PG_MAX) throw new Error(`MAX_PARAMETERS_EXCEEDED: ${params}`);
      const keys = new Set<string>();
      for (const r of rows) {
        const k = `${r.signalType}|${r.source}|${r.sourceRef}`;
        if (keys.has(k)) throw new Error("ON CONFLICT DO UPDATE command cannot affect row a second time");
        keys.add(k);
        stored.set(k, r);
      }
      statements.push(rows.length);
    },
  };
  return chain;
}

vi.mock("../../src/db/index.js", () => {
  const select = (rows: () => unknown[]) => {
    const chain = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: async () => rows(),
    };
    return chain;
  };
  // First select = the signal serve; inside loadJobPostings = the cached fetch.
  const tx = {
    execute: async () => undefined,
    select: () => select(() => [{ responseBody: { organization_job_postings: cachedPostings } }]),
    insert: () => insertChain(),
  };
  // First db.select = the signal serve; the next = loadJobPostings' lock-free cache read.
  let dbSelects = 0;
  return {
    db: {
      select: () =>
        dbSelects++ === 0
          ? select(() => [{ signal: { type: "hiring", window_days: 30, as_of: "2026-10-27" }, servedAt: new Date() }])
          : select(() => [{ responseBody: { organization_job_postings: cachedPostings } }]),
      insert: () => insertChain(),
      transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
});

import { buyingSignalForEnrich } from "../../src/lib/buying-signals.js";

function postings(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `posting-${i}`,
    title: i === 4321 ? "Office Manager" : `Engineer ${i}`,
    url: `https://jobs.example.com/${i}`,
    city: "London",
    country: "United Kingdom",
    posted_at: i === 9000 ? "2026-10-26T00:00:00Z" : "2026-08-01T00:00:00Z",
  }));
}

describe("buyingSignalForEnrich at a very large employer", () => {
  beforeEach(() => {
    statements.length = 0;
    stored.clear();
  });

  it("stores every posting in chunks under the parameter cap and returns the matched evidence", async () => {
    // 9,100 postings × 10 params ≈ 91,000: more than one statement can bind. One id repeats.
    cachedPostings = [...postings(9_100), { ...postings(1)[0] }];
    const evidence = await buyingSignalForEnrich({
      apolloPersonId: "p1",
      person: { id: "p1", organizationId: "org-lloyds", organizationName: "Lloyds Banking Group" },
      ctx: { identity: { orgId: "o", userId: "u", runId: "r" } as never, runId: "r" },
      now: new Date("2026-10-27T12:00:00Z"),
    });
    expect(stored.size).toBe(9_100);
    expect(statements.length).toBeGreaterThan(1);
    expect(evidence).toMatchObject({ type: "hiring", occurredOn: "2026-10-26", source: "apollo:job_postings" });
  });
});
