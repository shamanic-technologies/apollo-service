import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../../src/lib/cost-hold-ledger.js", () => ({
  recordOpenedHolds: vi.fn(),
  recordSettledHold: vi.fn(),
}));

import { createPlatformRun, createRun } from "../../src/lib/runs-client.js";
import { LIVE_SUPPORT_TASKS, PAST_SUPPORT_TASKS, markPastSupportRuns } from "../../src/lib/support-marks.js";

const fetchMock = vi.fn();
const reply = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const sentBody = (i: number) => JSON.parse(fetchMock.mock.calls[i][1].body as string);
const sentUrl = (i: number) => fetchMock.mock.calls[i][0] as string;
const selection = (toMarkCount: number) => ({
  matchedRunCount: toMarkCount,
  toMarkCount,
  alreadyMarkedCount: 0,
  declaresOutcomesCount: 0,
  onOutcomeNowCount: 0,
  spend: { grossCents: "1.0000000000", netCents: "1.0000000000" },
  maxRuns: 50000,
  tooMany: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("support at run creation (COST-SUPPORT-1024)", () => {
  it("createRun sends `support` only when given", async () => {
    fetchMock.mockImplementation(() => reply({ id: "r1" }, 201));
    await createRun({ orgId: "o", serviceName: "apollo-service", taskName: "audience-companies", support: LIVE_SUPPORT_TASKS["audience-companies"] });
    await createRun({ orgId: "o", serviceName: "apollo-service", taskName: "enrichment" });
    expect(sentBody(0).support).toEqual({ kind: "product_feature", reason: LIVE_SUPPORT_TASKS["audience-companies"].reason });
    expect("support" in sentBody(1)).toBe(false);
  });

  it("createPlatformRun forwards `support`", async () => {
    fetchMock.mockImplementation(() => reply({ id: "r2" }, 201));
    await createPlatformRun({ taskName: "person-role", idempotencyKey: "k", support: LIVE_SUPPORT_TASKS["person-role"] });
    expect(sentBody(0).support.kind).toBe("product_feature");
  });

  it("every support task is marked where its run is opened, and no production task is support", () => {
    const audiences = readFileSync(join(__dirname, "../../src/routes/audiences.ts"), "utf8");
    expect(audiences).toContain('support: supportOf("audience-companies")');
    const firmo = readFileSync(join(__dirname, "../../src/lib/company-firmographics.ts"), "utf8");
    expect(firmo).toContain("support: supportOf(taskName)");
    expect(firmo).toContain('onPlatformRun("company-firmographics"');
    expect(firmo).toContain('onPlatformRun("person-role"');
    for (const task of ["waterfall-enrichment", "search-params-generation", "enrichment", "person-match", "phone-reveal", "linkedin-engagement", "buying-signal-evidence", "verify-email", "email-find-treg"]) {
      expect(PAST_SUPPORT_TASKS[task]).toBeUndefined();
    }
  });
});

describe("markPastSupportRuns", () => {
  it("dryRun previews every task rule and explicit list, applies nothing", async () => {
    fetchMock.mockImplementation(() => reply(selection(3)));
    const steps = await markPastSupportRuns({
      dryRun: true,
      runMarks: [{ kind: "staff_experiment", reason: "probe", runIds: ["a3fde21d-1503-4008-9ffa-56c5115fe3c8"] }],
    });
    expect(steps).toHaveLength(Object.keys(PAST_SUPPORT_TASKS).length + 1);
    expect(fetchMock.mock.calls.every((c) => (c[0] as string).endsWith("/v1/platform-runs/support-marks/preview"))).toBe(true);
    expect(steps.every((s) => s.applied === null)).toBe(true);
    expect(sentBody(0)).toEqual({ kind: "staff_experiment", reason: PAST_SUPPORT_TASKS["experiment-treg-people-search"].reason, markedBy: "apollo-service", taskNames: ["experiment-treg-people-search"] });
    const last = sentBody(fetchMock.mock.calls.length - 1);
    expect(last).toEqual({ kind: "staff_experiment", reason: "probe", markedBy: "apollo-service", runIds: ["a3fde21d-1503-4008-9ffa-56c5115fe3c8"] });
    expect(fetchMock.mock.calls[0][1].headers["x-service-name"]).toBe("apollo-service");
  });

  it("applies a step with runs to mark, skips the apply when nothing is left", async () => {
    fetchMock
      .mockImplementationOnce(() => reply(selection(2)))
      .mockImplementationOnce(() => reply({ markedCount: 2, alreadyMarkedCount: 0, declaresOutcomesCount: 0 }))
      .mockImplementation(() => reply(selection(0)));
    const steps = await markPastSupportRuns({ dryRun: false });
    expect(sentUrl(1)).toMatch(/\/v1\/platform-runs\/support-marks\/apply$/);
    expect(steps[0].applied).toEqual({ markedCount: 2, alreadyMarkedCount: 0, declaresOutcomesCount: 0 });
    expect(steps.slice(1).every((s) => s.applied === null)).toBe(true);
  });

  it("a refused step fails loud", async () => {
    fetchMock.mockImplementation(() => reply({ error: "invalid_runs" }, 422));
    await expect(markPastSupportRuns({ dryRun: true })).rejects.toThrow(/422/);
  });
});
