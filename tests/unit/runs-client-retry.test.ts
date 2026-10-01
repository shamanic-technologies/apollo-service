import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/lib/cost-hold-ledger.js", () => ({
  recordOpenedHolds: vi.fn().mockResolvedValue(undefined),
  recordSettledHold: vi.fn().mockResolvedValue(undefined),
}));

import { addCosts, createRun, updateRun, RunsServiceError, RUNS_RETRY_DELAYS_MS } from "../../src/lib/runs-client.js";

const identity = { orgId: "org-1", userId: "user-1" };
const fetchMock = vi.fn();

function reply(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}
function abort() {
  const err = new Error("aborted");
  err.name = "AbortError";
  return Promise.reject(err);
}
function bodyOf(call: number) {
  return JSON.parse(String((fetchMock.mock.calls[call][1] as RequestInit).body));
}

describe("runs-client retries a stalled runs-service with idempotency keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    RUNS_RETRY_DELAYS_MS.splice(0, RUNS_RETRY_DELAYS_MS.length, 1, 1);
  });
  afterEach(() => {
    RUNS_RETRY_DELAYS_MS.splice(0, RUNS_RETRY_DELAYS_MS.length, 500, 2_000);
  });

  it("createRun retries a timeout with the SAME idempotency key", async () => {
    fetchMock.mockReturnValueOnce(abort()).mockReturnValueOnce(reply({ id: "run-1" }, 201));
    const run = await createRun({ orgId: "org-1", serviceName: "apollo-service", taskName: "verify-email" });
    expect(run.id).toBe("run-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const key = bodyOf(0).idempotencyKey;
    expect(key).toMatch(/^apollo-service:run:/);
    expect(bodyOf(1).idempotencyKey).toBe(key);
  });

  it("two distinct createRun calls never share a key", async () => {
    fetchMock.mockReturnValueOnce(reply({ id: "a" }, 201)).mockReturnValueOnce(reply({ id: "b" }, 201));
    await createRun({ orgId: "org-1", serviceName: "s", taskName: "t" });
    await createRun({ orgId: "org-1", serviceName: "s", taskName: "t" });
    expect(bodyOf(0).idempotencyKey).not.toBe(bodyOf(1).idempotencyKey);
  });

  it("addCosts retries a 503 replaying the same per-item keys", async () => {
    fetchMock
      .mockReturnValueOnce(reply({ error: "pool saturated" }, 503))
      .mockReturnValueOnce(reply({ costs: [{ id: "c1", status: "actual" }] }, 201));
    await addCosts("run-1", [{ costName: "apify-bounceverify-email", costSource: "platform", quantity: 1 }], identity);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const key = bodyOf(0).items[0].idempotencyKey;
    expect(key).toMatch(/^apollo-service:cost:/);
    expect(bodyOf(1).items[0].idempotencyKey).toBe(key);
  });

  it("does NOT retry a 4xx (a real answer)", async () => {
    fetchMock.mockReturnValueOnce(reply({ error: "Unknown cost" }, 422));
    await expect(
      addCosts("run-1", [{ costName: "nope", costSource: "platform", quantity: 1 }], identity)
    ).rejects.toBeInstanceOf(RunsServiceError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up loudly after the retry budget", async () => {
    fetchMock.mockImplementation(() => abort());
    await expect(updateRun("run-1", "completed", identity)).rejects.toThrow(/timed out/);
    expect(fetchMock).toHaveBeenCalledTimes(1 + RUNS_RETRY_DELAYS_MS.length);
  });
});
