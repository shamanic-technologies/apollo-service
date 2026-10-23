import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * COST-BACKFILL-1023: past outcomes parked from our own rows are declared on the
 * PAST runs through runs-service's batch backfill door (occurredAt =
 * run_started_at), never the live per-run door.
 */

const { FakeRunsServiceError, mockBatch, mockDeclare } = vi.hoisted(() => {
  class FakeRunsServiceError extends Error {
    constructor(public status: number, public body: string) {
      super(`runs-service ${status}`);
    }
  }
  return { FakeRunsServiceError, mockBatch: vi.fn(), mockDeclare: vi.fn() };
});
vi.mock("../../src/lib/runs-client.js", () => ({
  declareRunOutcomes: (...a: unknown[]) => mockDeclare(...a),
  declareOutcomesBatch: (...a: unknown[]) => mockBatch(...a),
  RunsServiceError: FakeRunsServiceError,
}));

let dueRows: any[] = [];
const updates: Array<{ set: any }> = [];
vi.mock("../../src/db/index.js", () => ({
  db: {
    update: () => ({
      set: (set: any) => {
        updates.push({ set });
        return { where: async () => [] };
      },
    }),
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => dueRows }) }) }) }),
  },
}));

import { backfillChunks, declareBackfillPass, refusedRunsOf, BACKFILL_MAX_RUNS, BACKFILL_MAX_OCCURRENCES } from "../../src/lib/outcome-declarations.js";
import { BACKFILL_CANDIDATES_SQL } from "../../src/lib/outcome-backfill.js";

const NOW = new Date("2026-10-23T12:00:00Z");
function row(partial: Record<string, unknown>) {
  return {
    id: "d-1", runId: "run-1", direction: "produced", outcomeKey: "email_found", personKey: "apollo:p-1",
    orgId: "org-1", brandIds: null, campaignId: null, apolloPersonId: "p-1", email: "ada@example.com", linkedinUrl: null,
    status: "pending", subjectService: null, leadId: null, attempts: 0, lastError: null,
    producedAt: NOW, nextAttemptAt: NOW, declaredAt: null, occurredAt: new Date("2026-08-01T10:00:00Z"),
    ...partial,
  };
}
const fetchMock = vi.fn();
const resolveAnswer = (ids: (string | null)[]) => ({ ok: true, json: async () => ({ people: ids.map((leadId) => ({ leadId })) }) });

beforeEach(() => {
  dueRows = [];
  updates.length = 0;
  mockBatch.mockReset();
  mockDeclare.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.env.LEAD_SERVICE_URL = "http://lead";
  process.env.LEAD_SERVICE_API_KEY = "k";
});
afterEach(() => vi.unstubAllGlobals());

describe("backfill declarations", () => {
  it("declares through the batch door with occurredAt = run_started_at, never the live door", async () => {
    dueRows = [
      row({ id: "a", runId: "run-v", direction: "produced", outcomeKey: "email_checked", personKey: "email:ada@example.com", apolloPersonId: null }),
      row({ id: "b", runId: "run-v", direction: "consumed", outcomeKey: "email_found", personKey: "email:ada@example.com", apolloPersonId: null }),
    ];
    fetchMock.mockResolvedValue(resolveAnswer(["lead-9", "lead-9"]));
    mockBatch.mockResolvedValue({ recordedCount: 2, alreadyRecordedCount: 0 });
    const r = await declareBackfillPass(NOW);
    expect(mockDeclare).not.toHaveBeenCalled();
    expect(mockBatch).toHaveBeenCalledWith([
      {
        runId: "run-v",
        occurredAt: "run_started_at",
        produced: [{ outcomeKey: "email_checked", subjectService: "lead-service", subjectId: "lead-9" }],
        consumed: [{ outcomeKey: "email_found", subjectService: "lead-service", subjectId: "lead-9" }],
      },
    ]);
    expect(r).toMatchObject({ due: 2, resolved: 2, declared: 2, noLead: 0 });
    expect(updates.some((u) => u.set.status === "declared")).toBe(true);
  });

  it("a person who is not a lead long after the fact never will be: abandoned at once; a recent one is re-asked", async () => {
    dueRows = [
      row({ id: "old", runId: "run-old" }),
      row({ id: "new", runId: "run-new", occurredAt: new Date("2026-10-22T10:00:00Z") }),
    ];
    fetchMock.mockResolvedValue(resolveAnswer([null, null]));
    const r = await declareBackfillPass(NOW);
    expect(r).toMatchObject({ noLead: 1, declared: 0 });
    expect(updates.filter((u) => u.set.status === "abandoned")).toHaveLength(1);
    expect(updates.some((u) => u.set.attempts === 1)).toBe(true);
    expect(mockBatch).not.toHaveBeenCalled();
  });

  it("a run the door refuses (422 invalid_runs) is abandoned with its reason and the rest is re-sent", async () => {
    dueRows = [row({ id: "a", runId: "run-a", leadId: "l-a" }), row({ id: "b", runId: "run-b", leadId: "l-b" })];
    mockBatch
      .mockRejectedValueOnce(new FakeRunsServiceError(422, JSON.stringify({ error: "invalid_runs", details: { invalid: [{ runId: "run-a", reason: "run_not_found" }] } })))
      .mockResolvedValueOnce({ recordedCount: 1, alreadyRecordedCount: 0 });
    const r = await declareBackfillPass(NOW);
    expect(mockBatch).toHaveBeenCalledTimes(2);
    expect(mockBatch.mock.calls[1][0].map((x: any) => x.runId)).toEqual(["run-b"]);
    expect(r).toMatchObject({ invalid: 1, declared: 1 });
    expect(updates.some((u) => u.set.status === "abandoned" && /run_not_found/.test(u.set.lastError))).toBe(true);
  });

  it("a support-marked run (409 naming no run) is isolated by halving and abandoned; the others are declared", async () => {
    dueRows = ["a", "b", "c", "d"].map((x) => row({ id: x, runId: `run-${x}`, leadId: `l-${x}` }));
    const marked = new FakeRunsServiceError(409, JSON.stringify({ error: "run_marked_support", conflicts: [] }));
    mockBatch.mockImplementation(async (runs: any[]) => {
      if (runs.some((r) => r.runId === "run-c")) throw marked;
      return { recordedCount: runs.length, alreadyRecordedCount: 0 };
    });
    const r = await declareBackfillPass(NOW);
    expect(r).toMatchObject({ declared: 3, invalid: 1, failed: 0 });
    expect(updates.some((u) => u.set.status === "abandoned" && /run_marked_support/.test(u.set.lastError))).toBe(true);
    const declaredRuns = mockBatch.mock.calls.filter((c) => !c[0].some((r: any) => r.runId === "run-c")).flatMap((c) => c[0].map((r: any) => r.runId));
    expect(declaredRuns.sort()).toEqual(["run-a", "run-b", "run-d"]);
  });

  it("asks lead-service in chunks small enough for its body limit, answers kept in order", async () => {
    dueRows = Array.from({ length: 450 }, (_, i) => row({ id: `r${i}`, runId: `run-${i}`, apolloPersonId: `p-${i}`, personKey: `apollo:p-${i}` }));
    fetchMock.mockImplementation(async (_url: string, init: any) => resolveAnswer(JSON.parse(init.body).people.map((p: any) => `lead-${p.apolloPersonId}`)));
    mockBatch.mockResolvedValue({ recordedCount: 0, alreadyRecordedCount: 0 });
    const r = await declareBackfillPass(NOW);
    expect(fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).people.length)).toEqual([200, 200, 50]);
    expect(r).toMatchObject({ resolved: 450, declared: 450 });
    expect(mockBatch.mock.calls[0][0][0].produced[0].subjectId).toBe("lead-p-0");
  });

  it("a transient failure keeps every row pending with its error (retried next pass)", async () => {
    dueRows = [row({ id: "a", leadId: "l-a" })];
    mockBatch.mockRejectedValue(new FakeRunsServiceError(502, "{}"));
    const r = await declareBackfillPass(NOW);
    expect(r).toMatchObject({ failed: 1, declared: 0 });
    expect(updates.some((u) => u.set.attempts === 1 && /backfill declare/.test(u.set.lastError))).toBe(true);
  });

  it("chunks respect the door's caps: ≤ 500 runs and ≤ 1000 occurrences per call", () => {
    const many = Array.from({ length: 1200 }, (_, i) => row({ id: `r${i}`, runId: `run-${i}`, leadId: "l" }));
    const chunks = backfillChunks(many as any);
    expect(chunks.every((c) => c.runs.length <= BACKFILL_MAX_RUNS)).toBe(true);
    expect(chunks.map((c) => c.runs.length)).toEqual([500, 500, 200]);
    const pairs = Array.from({ length: 700 }, (_, i) => [
      row({ id: `p${i}`, runId: `run-${i}`, leadId: "l", outcomeKey: "email_checked" }),
      row({ id: `c${i}`, runId: `run-${i}`, leadId: "l", direction: "consumed" }),
    ]).flat();
    const pc = backfillChunks(pairs as any);
    expect(pc.every((c) => c.rows.length <= BACKFILL_MAX_OCCURRENCES)).toBe(true);
    expect(pc.reduce((n, c) => n + c.rows.length, 0)).toBe(1400);
  });

  it("only a 422/409 naming runs is a per-run refusal", () => {
    expect(refusedRunsOf(new FakeRunsServiceError(422, JSON.stringify({ details: { invalid: [{ runId: "x", reason: "invalid_occurred_at" }] } })))?.get("x")).toBe("invalid_occurred_at");
    expect(refusedRunsOf(new FakeRunsServiceError(409, JSON.stringify({ error: "quantity_conflict", conflicts: [{ runId: "y" }] })))?.has("y")).toBe(true);
    expect(refusedRunsOf(new FakeRunsServiceError(502, "{}"))).toBeNull();
    expect(refusedRunsOf(new Error("x"))).toBeNull();
  });
});

describe("what the backfill reads from our own rows (same rules as the live production points)", () => {
  it("reveals and finds produce email_found; verifications email_checked + consumed email_found; phones phone_found", () => {
    expect(BACKFILL_CANDIDATES_SQL).toContain("e.email_status = 'verified'");
    expect(BACKFILL_CANDIDATES_SQL).toContain("f.status = 'found'");
    expect(BACKFILL_CANDIDATES_SQL).toContain("('produced', 'email_checked'), ('consumed', 'email_found')");
    expect(BACKFILL_CANDIDATES_SQL).toContain("p.status = 'found'");
  });
  it("a step-1 catch_all/unknown counts only before BounceBan existed (after, BounceBan's verdict decides)", () => {
    expect(BACKFILL_CANDIDATES_SQL).toContain("v.verifier = 'bounceban' OR v.verdict = 'valid' OR b.at IS NULL OR v.verified_at < b.at");
  });
  it("mailing-list subscribers and probes are not leads: never parked", () => {
    expect(BACKFILL_CANDIDATES_SQL).toContain("NOT LIKE 'verify:transactional-email-service%'");
    expect(BACKFILL_CANDIDATES_SQL).toContain("<> 'reveal-domain-probe'");
  });
});
