import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Every treg call of the linkedin_engagement signal is metered on the caller's
 * org: PROVISION the ceiling → AUTHORIZE → EXECUTE → post treg's own charge as
 * actual → cancel the hold, with the exchange written to bronze.
 */

const mockCreateRun = vi.fn();
const mockAddCosts = vi.fn();
const mockUpdateCostStatus = vi.fn().mockResolvedValue({});
const mockUpdateRun = vi.fn().mockResolvedValue({});
vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...a: unknown[]) => mockCreateRun(...a),
  addCosts: (...a: unknown[]) => mockAddCosts(...a),
  updateCostStatus: (...a: unknown[]) => mockUpdateCostStatus(...a),
  updateRun: (...a: unknown[]) => mockUpdateRun(...a),
}));

const mockAuthorize = vi.fn();
vi.mock("../../src/lib/billing-client.js", () => ({ authorizeCredit: (...a: unknown[]) => mockAuthorize(...a) }));

vi.mock("../../src/lib/keys-client.js", () => ({
  decryptKey: vi.fn().mockImplementation((_o: string, _u: string, provider: string) =>
    Promise.resolve({ key: provider === "treg-org" ? "distribute-you" : "treg-token", keySource: "platform" }),
  ),
}));

const bronze: Array<Record<string, unknown>> = [];
vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: vi.fn().mockImplementation(() => ({
      values: (v: Record<string, unknown>) => {
        bronze.push(v);
        return Promise.resolve();
      },
    })),
  },
}));

const order: string[] = [];
const fetchMock = vi.fn();

const ctx = {
  identity: { orgId: "org-1", userId: "user-1", brandIds: ["brand-1"], campaignId: "camp-1", audienceId: "aud-1" },
  userId: "user-1",
  runId: "run-parent",
  tracking: { brandIds: ["brand-1"], campaignId: "camp-1", audienceId: "aud-1" },
  callerPath: "/search/next",
};

function answer(status: number, body: unknown, cost: string | null) {
  const headers = new Headers({ "content-type": "application/json" });
  if (cost !== null) headers.set("x-treg-cost-micro", cost);
  return new Response(JSON.stringify(body), { status, headers });
}

describe("EngagementMeter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bronze.length = 0;
    order.length = 0;
    mockCreateRun.mockImplementation(() => Promise.resolve({ id: "run-li" }));
    mockAddCosts.mockImplementation((_r: string, items: Array<{ status?: string }>) => {
      order.push(items[0].status === "provisioned" ? "provision" : "actual");
      return Promise.resolve({ costs: [{ id: "hold-1" }] });
    });
    mockUpdateCostStatus.mockImplementation(() => {
      order.push("cancel-hold");
      return Promise.resolve({});
    });
    mockAuthorize.mockImplementation(() => {
      order.push("authorize");
      return Promise.resolve({ sufficient: true, balance_cents: 1000, required_cents: 1 });
    });
    fetchMock.mockImplementation(() => {
      order.push("execute");
      return Promise.resolve(answer(200, { output: { posts: [] } }, "1880"));
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("provision → authorize → execute → actual (treg's own figure) → cancel hold, org-billed, bronze written", async () => {
    const { EngagementMeter, PROFILE_ENDPOINT } = await import("../../src/lib/linkedin-engagement.js");
    const meter = new EngagementMeter(ctx);
    const res = await meter.call(PROFILE_ENDPOINT, { method: "POST", body: { linkedin_url: "https://www.linkedin.com/in/x" }, maxMicro: 5000, routed: true });
    expect(res).toMatchObject({ status: 200, chargedMicro: 1880 });
    expect(order).toEqual(["provision", "authorize", "execute", "actual", "cancel-hold"]);
    expect(mockCreateRun).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-1", campaignId: "camp-1", audienceId: "aud-1", taskName: "linkedin-engagement", parentRunId: "run-parent" }));
    expect(mockAddCosts.mock.calls[0][1]).toEqual([{ costName: "treg-micro-usd", costSource: "platform", quantity: 5000, status: "provisioned" }]);
    expect(mockAddCosts.mock.calls[1][1]).toEqual([{ costName: "treg-micro-usd", costSource: "platform", quantity: 1880 }]);
    expect(mockAuthorize).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-1", items: [{ costName: "treg-micro-usd", quantity: 5000 }] }));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://treg.to/call/treg.linkedin.user.profile");
    expect(init.headers).toMatchObject({ "X-Treg-Token": "treg-token", "X-Treg-Org": "distribute-you", "X-Treg-Route-Max-Cost": "0.005000", "Cache-Control": "no-cache" });
    expect(bronze[0]).toMatchObject({ endpoint: PROFILE_ENDPOINT, runId: "run-li", httpStatus: 200, chargedMicro: 1880 });
    expect(meter.chargedMicro).toBe(1880);
  });

  it("a miss treg did not bill: hold cancelled, no actual", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(answer(502, { detail: { error: "route_failed", tried: [{ outcome: "miss", charged_micro: 0 }] } }, "0")));
    const { EngagementMeter, PROFILE_ENDPOINT, isRoutedMiss } = await import("../../src/lib/linkedin-engagement.js");
    const meter = new EngagementMeter(ctx);
    const res = await meter.call(PROFILE_ENDPOINT, { method: "POST", body: { linkedin_url: "x" }, maxMicro: 5000, routed: true });
    expect(isRoutedMiss(res)).toBe(true);
    expect(mockAddCosts).toHaveBeenCalledTimes(1);
    expect(mockUpdateCostStatus).toHaveBeenCalledWith("run-li", "hold-1", "cancelled", ctx.identity);
  });

  it("an org that cannot pay: hold released, nothing called, 402 error", async () => {
    mockAuthorize.mockResolvedValue({ sufficient: false, balance_cents: 0, required_cents: 1 });
    const { EngagementMeter, ENGAGEMENT_ENDPOINT, LinkedinEngagementInsufficientCreditError } = await import("../../src/lib/linkedin-engagement.js");
    const meter = new EngagementMeter(ctx);
    await expect(meter.call(ENGAGEMENT_ENDPOINT, { method: "GET", query: { postUrlOrUrn: "urn:li:activity:1" }, maxMicro: 3000, routed: false })).rejects.toBeInstanceOf(LinkedinEngagementInsufficientCreditError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockUpdateCostStatus).toHaveBeenCalledWith("run-li", "hold-1", "cancelled", ctx.identity);
  });

  it("a 200 with no charge header cannot be declared: fails loud and KEEPS the hold", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(answer(200, { output: {} }, null)));
    const { EngagementMeter, PROFILE_ENDPOINT } = await import("../../src/lib/linkedin-engagement.js");
    const meter = new EngagementMeter(ctx);
    await expect(meter.call(PROFILE_ENDPOINT, { method: "POST", body: {}, maxMicro: 5000, routed: true })).rejects.toThrow(/X-Treg-Cost-Micro/);
    expect(mockUpdateCostStatus).not.toHaveBeenCalled();
    expect(bronze[0]).toMatchObject({ httpStatus: 200, chargedMicro: null });
  });

  it("profile lookups skip anyapi (0 of 62 hits, +8-10s each in prod)", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(answer(200, { output: {} }, "1500")));
    const { EngagementMeter, PROFILE_ENDPOINT, PROFILE_ROUTE_EXCLUDE } = await import("../../src/lib/linkedin-engagement.js");
    const meter = new EngagementMeter(ctx);
    await meter.call(PROFILE_ENDPOINT, { method: "POST", body: { linkedin_url: "x" }, maxMicro: 5000, routed: true, exclude: PROFILE_ROUTE_EXCLUDE });
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ "X-Treg-Route-Exclude": "anyapi", "X-Treg-Route-Max-Cost": "0.005000" });
  });

  it("concurrent calls share ONE child run and every call is still metered", async () => {
    let resolveRun: (v: { id: string }) => void = () => {};
    mockCreateRun.mockImplementation(() => new Promise((r) => (resolveRun = r)));
    fetchMock.mockImplementation(() => Promise.resolve(answer(200, { output: {} }, "1500")));
    const { EngagementMeter, PROFILE_ENDPOINT } = await import("../../src/lib/linkedin-engagement.js");
    const meter = new EngagementMeter(ctx);
    const all = Promise.all([1, 2, 3, 4].map(() => meter.call(PROFILE_ENDPOINT, { method: "POST", body: {}, maxMicro: 5000, routed: true })));
    await new Promise((r) => setTimeout(r, 0));
    resolveRun({ id: "run-li" });
    await all;
    expect(mockCreateRun).toHaveBeenCalledTimes(1);
    expect(meter.calls).toBe(4);
    expect(meter.chargedMicro).toBe(6000);
    expect(mockAuthorize).toHaveBeenCalledTimes(4);
    expect(order.filter((o) => o === "actual")).toHaveLength(4);
    expect(order.filter((o) => o === "cancel-hold")).toHaveLength(4);
  });
});

describe("mapPool", () => {
  it("never runs more than the limit at once and keeps input order", async () => {
    const { mapPool } = await import("../../src/lib/linkedin-engagement.js");
    let running = 0;
    let peak = 0;
    const res = await mapPool([30, 10, 20, 5, 15], 2, async (ms) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, ms));
      running--;
      return ms * 2;
    });
    expect(peak).toBe(2);
    expect(res.map((r) => (r as PromiseFulfilledResult<number>).value)).toEqual([60, 20, 40, 10, 30]);
  });

  it("stops starting new work after a failure and reports it", async () => {
    const { mapPool } = await import("../../src/lib/linkedin-engagement.js");
    const started: number[] = [];
    const res = await mapPool([1, 2, 3, 4], 1, async (n) => {
      started.push(n);
      if (n === 2) throw new Error("boom");
      return n;
    });
    expect(started).toEqual([1, 2]);
    expect(res[1]).toMatchObject({ status: "rejected" });
    expect(res[2]).toBeUndefined();
  });
});
