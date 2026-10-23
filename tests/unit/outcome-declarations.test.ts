import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * COST-ACCOUNTING-1023: every paid production point parks the outcome it
 * produced for ONE person; the declarer resolves the person's lead in
 * lead-service and declares on OUR run with subject (lead-service, leadId).
 */

const mockDeclare = vi.fn();
vi.mock("../../src/lib/runs-client.js", () => ({
  declareRunOutcomes: (...a: unknown[]) => mockDeclare(...a),
}));

// Chainable drizzle stand-in: records every write, serves `dueRows` to the SELECT.
let dueRows: any[] = [];
const inserts: any[][] = [];
const updates: Array<{ set: any }> = [];
let insertFails = false;
vi.mock("../../src/db/index.js", () => {
  const whereResult = () => {
    const p: any = Promise.resolve([]);
    p.returning = async () => [];
    return p;
  };
  return {
    db: {
      insert: () => ({
        values: (v: any[]) => ({
          onConflictDoNothing: async () => {
            if (insertFails) throw new Error("db down");
            inserts.push(v);
          },
        }),
      }),
      update: () => ({
        set: (set: any) => {
          updates.push({ set });
          return { where: whereResult };
        },
      }),
      select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => dueRows }) }) }) }),
    },
  };
});

import {
  declarationBody,
  declarePendingOutcomes,
  isKeptVerdict,
  personKeyOf,
  recordOutcome,
  SUBJECT_SERVICE,
  toResolveItem,
} from "../../src/lib/outcome-declarations.js";

const fetchMock = vi.fn();

function row(partial: Record<string, unknown>) {
  return {
    id: "d-1",
    runId: "run-1",
    direction: "produced",
    outcomeKey: "email_found",
    personKey: "apollo:p-1",
    orgId: "org-1",
    brandIds: ["b-1"],
    campaignId: "c-1",
    apolloPersonId: "p-1",
    email: "ada@example.com",
    linkedinUrl: null,
    status: "pending",
    leadId: null,
    attempts: 0,
    lastError: null,
    producedAt: new Date("2026-10-23T10:00:00Z"),
    nextAttemptAt: new Date("2026-10-23T10:00:00Z"),
    declaredAt: null,
    ...partial,
  };
}

beforeEach(() => {
  dueRows = [];
  inserts.length = 0;
  updates.length = 0;
  insertFails = false;
  mockDeclare.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.env.LEAD_SERVICE_URL = "http://lead";
  process.env.LEAD_SERVICE_API_KEY = "k";
});
afterEach(() => vi.unstubAllGlobals());

describe("what a run produced, per task", () => {
  it("subject is ALWAYS the person's lead in lead-service", () => {
    expect(SUBJECT_SERVICE).toBe("lead-service");
    const body = declarationBody([
      { direction: "produced", outcomeKey: "email_checked", leadId: "lead-9" },
      { direction: "consumed", outcomeKey: "email_found", leadId: "lead-9" },
    ]);
    expect(body).toEqual({
      produced: [{ outcomeKey: "email_checked", subjectService: "lead-service", subjectId: "lead-9" }],
      consumed: [{ outcomeKey: "email_found", subjectService: "lead-service", subjectId: "lead-9" }],
    });
  });

  it("a caller-named subject is parked already resolved and declared on that subject (no lead-service ask)", async () => {
    await recordOutcome({ runId: "run-v", orgId: "org-1", subject: { subjectService: "transactional-email-service", subjectId: "sub-1" }, produced: ["email_checked"], person: { email: "a@b.c" } });
    expect(inserts[0][0]).toMatchObject({ subjectService: "transactional-email-service", leadId: "sub-1" });
    expect(declarationBody([{ direction: "produced", outcomeKey: "email_checked", leadId: "sub-1", subjectService: "transactional-email-service" }]).produced).toEqual([
      { outcomeKey: "email_checked", subjectService: "transactional-email-service", subjectId: "sub-1" },
    ]);
  });

  it("a verification is KEPT on valid, catch_all, unknown; invalid / risky / no verdict are losses", () => {
    expect(["valid", "catch_all", "unknown"].map(isKeptVerdict)).toEqual([true, true, true]);
    expect(["invalid", "risky", null, undefined].map(isKeptVerdict)).toEqual([false, false, false, false]);
  });

  it("one person key: apollo id, else lowercased email, else linkedin url", () => {
    expect(personKeyOf({ apolloPersonId: "p", email: "A@x.com" })).toBe("apollo:p");
    expect(personKeyOf({ email: " A@X.com " })).toBe("email:a@x.com");
    expect(personKeyOf({ linkedinUrl: "http://www.linkedin.com/in/ada" })).toBe("linkedin:http://www.linkedin.com/in/ada");
    expect(personKeyOf({})).toBeNull();
  });

  it("parks one row per direction x key, idempotent on conflict (a replay parks nothing twice)", async () => {
    await recordOutcome({ runId: "run-v", orgId: "org-1", brandIds: ["b-1"], campaignId: "c-1", produced: ["email_checked"], consumed: ["email_found"], person: { email: "Ada@Example.com" } });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toEqual([
      expect.objectContaining({ runId: "run-v", direction: "produced", outcomeKey: "email_checked", personKey: "email:ada@example.com", email: "ada@example.com", orgId: "org-1", brandIds: ["b-1"] }),
      expect.objectContaining({ runId: "run-v", direction: "consumed", outcomeKey: "email_found", personKey: "email:ada@example.com" }),
    ]);
  });

  it("never throws: a failed park is logged and the action it accompanies goes on", async () => {
    insertFails = true;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(recordOutcome({ runId: "r", orgId: "o", produced: ["email_found"], person: { email: "a@b.c" } })).resolves.toBeUndefined();
    expect(err.mock.calls.some((c) => String(c[0]).includes("park_failed"))).toBe(true);
    err.mockRestore();
  });

  it("asks lead-service with org, brands and every identity it holds", () => {
    expect(toResolveItem(row({ linkedinUrl: "http://www.linkedin.com/in/ada" }) as any)).toEqual({
      orgId: "org-1",
      brandIds: ["b-1"],
      apolloPersonId: "p-1",
      email: "ada@example.com",
      linkedinUrl: "http://www.linkedin.com/in/ada",
    });
  });
});

describe("the declarer", () => {
  it("resolves the lead, then declares on OUR run with subject (lead-service, leadId)", async () => {
    dueRows = [row({}), row({ id: "d-2", runId: "run-2", outcomeKey: "email_checked", personKey: "email:ada@example.com" })];
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ people: [{ leadId: "lead-1", matchedBy: "apollo_person_id" }, { leadId: "lead-1", matchedBy: "email" }] }), { status: 200 }));
    mockDeclare.mockResolvedValue({ runId: "x", recordedCount: 1, alreadyRecordedCount: 0 });

    const r = await declarePendingOutcomes(new Date("2026-10-23T10:05:00Z"));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://lead/internal/leads/ids/resolve");
    expect(init.headers["x-api-key"]).toBe("k");
    expect(JSON.parse(init.body).people).toHaveLength(2);
    expect(mockDeclare).toHaveBeenCalledWith("run-1", "org-1", {
      produced: [{ outcomeKey: "email_found", subjectService: "lead-service", subjectId: "lead-1" }],
      consumed: [],
    });
    expect(mockDeclare).toHaveBeenCalledWith("run-2", "org-1", {
      produced: [{ outcomeKey: "email_checked", subjectService: "lead-service", subjectId: "lead-1" }],
      consumed: [],
    });
    expect(r).toMatchObject({ due: 2, resolved: 2, declared: 2, failedRuns: 0 });
    expect(updates.some((u) => u.set.status === "declared")).toBe(true);
  });

  it("a person not (yet) a lead is NOT declared: retried later, never invented", async () => {
    dueRows = [row({})];
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ people: [{ leadId: null, matchedBy: null }] }), { status: 200 }));
    const r = await declarePendingOutcomes(new Date("2026-10-23T10:05:00Z"));
    expect(mockDeclare).not.toHaveBeenCalled();
    expect(r).toMatchObject({ unresolved: 1, declared: 0 });
    expect(updates.some((u) => u.set.attempts === 1 && u.set.nextAttemptAt instanceof Date)).toBe(true);
  });

  it("a failed declaration stays pending with its error (loud), retried next pass", async () => {
    dueRows = [row({ leadId: "lead-1" })];
    mockDeclare.mockRejectedValue(new Error("runs-service 502"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await declarePendingOutcomes(new Date("2026-10-23T10:05:00Z"));
    expect(fetchMock).not.toHaveBeenCalled(); // already resolved: no second ask
    expect(r).toMatchObject({ failedRuns: 1, declared: 0 });
    expect(updates.some((u) => String(u.set.lastError).includes("runs-service 502"))).toBe(true);
    expect(err.mock.calls.some((c) => String(c[0]).includes("declare_failed"))).toBe(true);
    err.mockRestore();
  });

  it("lead-service down: nothing declared, rows retried, the failure logged", async () => {
    dueRows = [row({})];
    fetchMock.mockResolvedValue(new Response("boom", { status: 503 }));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await declarePendingOutcomes(new Date("2026-10-23T10:05:00Z"));
    expect(mockDeclare).not.toHaveBeenCalled();
    expect(r).toMatchObject({ declared: 0 });
    expect(updates.some((u) => String(u.set.lastError).startsWith("resolve:"))).toBe(true);
    err.mockRestore();
  });
});
