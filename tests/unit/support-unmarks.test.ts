import { describe, it, expect, vi, beforeEach } from "vitest";

/** LEDGER-RESIDUAL-1025: unmark through the OWNER door, then re-open only the rows refused as support. */

const { calls, mockPreview, mockApply } = vi.hoisted(() => ({
  calls: [] as string[],
  mockPreview: vi.fn(),
  mockApply: vi.fn(),
}));
vi.mock("../../src/lib/runs-client.js", () => ({
  previewOwnSupportUnmarks: (b: unknown) => { calls.push("preview"); return mockPreview(b); },
  applyOwnSupportUnmarks: (b: unknown) => { calls.push("apply"); return mockApply(b); },
  previewOwnSupportMarks: vi.fn(),
  applyOwnSupportMarks: vi.fn(),
}));
const updates: any[] = [];
vi.mock("../../src/db/index.js", () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => [{ n: 3 }] }) }),
    update: () => ({
      set: (set: any) => ({
        where: () => ({ returning: async () => { calls.push("reopen"); updates.push(set); return [{ id: "a" }, { id: "b" }]; } }),
      }),
    }),
  },
}));

import { unmarkReusedSupportRuns } from "../../src/lib/support-unmarks.js";

const preview = { toUnmarkCount: 2, byFunction: { staff_experiment: 2 }, spend: { grossCents: "1", netCents: "1" }, maxRuns: 5000, tooMany: false };
const RUNS = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];

beforeEach(() => {
  calls.length = 0;
  updates.length = 0;
  mockPreview.mockReset().mockResolvedValue(preview);
  mockApply.mockReset().mockResolvedValue({ unmarkedCount: 2, notMarkedCount: 0 });
});

describe("unmarkReusedSupportRuns", () => {
  it("a dry run previews and counts, never unmarks or re-opens", async () => {
    const r = await unmarkReusedSupportRuns({ dryRun: true, runIds: RUNS, reason: "reused" });
    expect(calls).toEqual(["preview"]);
    expect(r).toMatchObject({ dryRun: true, applied: null, reopened: 3 });
  });

  it("apply unmarks BEFORE re-opening, as apollo-service, the listed runs only", async () => {
    const r = await unmarkReusedSupportRuns({ dryRun: false, runIds: RUNS, reason: "reused" });
    expect(calls).toEqual(["preview", "apply", "reopen"]);
    expect(mockApply.mock.calls[0][0]).toEqual({ reason: "reused", unmarkedBy: "apollo-service", runIds: RUNS });
    expect(updates[0]).toMatchObject({ status: "pending", attempts: 0, lastError: null });
    expect(r).toMatchObject({ applied: { unmarkedCount: 2 }, reopened: 2 });
  });

  it("a refused unmark re-opens nothing (fails loud)", async () => {
    mockApply.mockRejectedValue(new Error("runs-service 422 not_run_owner"));
    await expect(unmarkReusedSupportRuns({ dryRun: false, runIds: RUNS, reason: "reused" })).rejects.toThrow("not_run_owner");
    expect(calls).not.toContain("reopen");
  });
});
