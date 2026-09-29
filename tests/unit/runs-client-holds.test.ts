import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRecordOpened = vi.fn();
const mockRecordSettled = vi.fn();
vi.mock("../../src/lib/cost-hold-ledger.js", () => ({
  recordOpenedHolds: (...a: unknown[]) => mockRecordOpened(...a),
  recordSettledHold: (...a: unknown[]) => mockRecordSettled(...a),
}));

import { addCosts, updateCostStatus } from "../../src/lib/runs-client.js";

const identity = { orgId: "org-1", userId: "user-1", brandIds: ["b1"], campaignId: "c1" };
const fetchMock = vi.fn();

function reply(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

describe("runs-client keeps the local hold ledger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    mockRecordOpened.mockResolvedValue(undefined);
    mockRecordSettled.mockResolvedValue(undefined);
  });

  it("records every provisioned cost runs-service returns", async () => {
    fetchMock.mockReturnValueOnce(
      reply({ costs: [{ id: "cost-1", costName: "treg-micro-usd", costSource: "platform", quantity: "10000.000000", status: "provisioned" }] }, 201)
    );
    await addCosts("run-1", [{ costName: "treg-micro-usd", costSource: "platform", quantity: 10000, status: "provisioned" }], identity);
    expect(mockRecordOpened).toHaveBeenCalledWith(
      [{ costId: "cost-1", runId: "run-1", costName: "treg-micro-usd", costSource: "platform", quantity: "10000.000000" }],
      identity
    );
  });

  it("does not touch the ledger for an actual cost", async () => {
    fetchMock.mockReturnValueOnce(reply({ costs: [{ id: "cost-2", costName: "apollo-credit", costSource: "platform", quantity: "1", status: "actual" }] }, 201));
    await addCosts("run-1", [{ costName: "apollo-credit", costSource: "platform", quantity: 1 }], identity);
    expect(mockRecordOpened).not.toHaveBeenCalled();
  });

  it("a hold the ledger could not record is released in runs-service, then the call fails loudly", async () => {
    fetchMock
      .mockReturnValueOnce(reply({ costs: [{ id: "cost-3", costName: "treg-micro-usd", costSource: "platform", quantity: "1", status: "provisioned" }] }, 201))
      .mockReturnValueOnce(reply({ id: "cost-3", status: "cancelled" }));
    mockRecordOpened.mockRejectedValueOnce(new Error("db down"));

    await expect(
      addCosts("run-1", [{ costName: "treg-micro-usd", costSource: "platform", quantity: 1, status: "provisioned" }], identity)
    ).rejects.toThrow("db down");
    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toContain("/v1/runs/run-1/costs/cost-3");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ status: "cancelled" });
  });

  it("marks the hold settled whenever a path closes it", async () => {
    fetchMock.mockReturnValueOnce(reply({ id: "cost-1", status: "cancelled" }));
    await updateCostStatus("run-1", "cost-1", "cancelled", identity);
    expect(mockRecordSettled).toHaveBeenCalledWith("cost-1", "cancelled", "request");
  });
});
