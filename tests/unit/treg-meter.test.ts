import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAddCosts = vi.fn();
const mockUpdateCostStatus = vi.fn().mockResolvedValue({});
const mockCreateRun = vi.fn().mockResolvedValue({ id: "run-child" });
const mockUpdateRun = vi.fn().mockResolvedValue({});
vi.mock("../../src/lib/runs-client.js", () => ({
  addCosts: (...a: unknown[]) => mockAddCosts(...a),
  updateCostStatus: (...a: unknown[]) => mockUpdateCostStatus(...a),
  createRun: (...a: unknown[]) => mockCreateRun(...a),
  updateRun: (...a: unknown[]) => mockUpdateRun(...a),
}));
const mockAuthorize = vi.fn();
vi.mock("../../src/lib/billing-client.js", () => ({ authorizeCredit: (...a: unknown[]) => mockAuthorize(...a) }));
vi.mock("../../src/lib/keys-client.js", () => ({ decryptKey: vi.fn().mockResolvedValue({ key: "k", keySource: "platform" }) }));

import { TregMeter, TregMeterCreditError } from "../../src/lib/treg-meter.js";

const ctx = { identity: { orgId: "org-1", userId: "u-1" }, userId: "u-1", runId: "run-parent", tracking: {}, callerPath: "/search/next", taskName: "free-people-source" };

function answer(cost: string, status = 200) {
  return new Response(JSON.stringify({ leads: [] }), { status, headers: { "x-treg-cost-micro": cost } });
}

describe("TregMeter — Leadsforge billed $0.005 per search since 2026-11-20", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAddCosts.mockResolvedValue({ costs: [{ id: "hold-1" }] });
    mockAuthorize.mockResolvedValue({ sufficient: true });
  });

  it("a billed call: hold, authorize, actual charge declared, hold cancelled", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(answer("5000")));
    const res = await new TregMeter(ctx).post("leadsforge.people.search", { limit: 50 }, { timeoutMs: 1000 });
    expect(res.chargedMicro).toBe(5000);
    expect(mockAddCosts.mock.calls[0][1][0]).toMatchObject({ costName: "treg-micro-usd", quantity: 10_000, status: "provisioned" });
    expect(mockAddCosts.mock.calls[1][1][0]).toMatchObject({ costName: "treg-micro-usd", quantity: 5000 });
    expect(mockUpdateCostStatus).toHaveBeenCalledWith("run-child", "hold-1", "cancelled", ctx.identity);
  });

  it("a free call declares nothing beyond the released hold", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(answer("0")));
    await new TregMeter(ctx).post("dropleads.people.search", {}, { timeoutMs: 1000 });
    expect(mockAddCosts).toHaveBeenCalledTimes(1);
    expect(mockUpdateCostStatus).toHaveBeenCalledWith("run-child", "hold-1", "cancelled", ctx.identity);
  });

  it("credit refused: hold released, treg never called", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mockAuthorize.mockResolvedValue({ sufficient: false });
    await expect(new TregMeter(ctx).post("leadsforge.people.search", {}, { timeoutMs: 1000 })).rejects.toBeInstanceOf(TregMeterCreditError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockUpdateCostStatus).toHaveBeenCalledWith("run-child", "hold-1", "cancelled", ctx.identity);
  });

  it("a 200 without a charge header fails loud (the charge cannot be declared)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
    await expect(new TregMeter(ctx).post("leadsforge.people.search", {}, { timeoutMs: 1000 })).rejects.toThrow(/without X-Treg-Cost-Micro/);
  });
});
