import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";

const mockExecute = vi.fn();
vi.mock("../../src/db/index.js", () => ({
  db: { execute: (...args: unknown[]) => mockExecute(...args) },
  getSql: () => ({}),
}));
const mockRunsBatch = vi.fn();
vi.mock("../../src/lib/runs-client.js", async (orig) => ({
  ...(await orig<object>()),
  getRunCostsBatch: (...args: unknown[]) => mockRunsBatch(...args),
}));

const KEY = "unit-test-apollo-key";
process.env.APOLLO_SERVICE_API_KEY = KEY;

const { default: app } = await import("../../src/index.js");

const ORG = "308f528f-03ad-44b1-9cbc-623a6af9ba0e";

function servedLeads(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    ref: randomUUID(),
    servedCampaignId: randomUUID(),
    servedAt: new Date(Date.UTC(2026, 9, 15, 0, 0, i % 60)).toISOString(),
    apolloPersonId: `64a1f2b3c4d5e6f7a8b9${String(i).padStart(4, "0")}`,
    email: `firstname.lastname${i}@some-company-domain.com`,
  }));
}

describe("JSON body limits", () => {
  beforeEach(() => {
    mockExecute.mockReset().mockResolvedValue([]);
    mockRunsBatch.mockReset().mockResolvedValue([]);
  });

  it("accepts 5000 served leads on /internal/acquisition-costs (route reached)", async () => {
    const body = { orgId: ORG, servedLeads: servedLeads(5000) };
    expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(100 * 1024);
    const res = await request(app).post("/internal/acquisition-costs").set("x-api-key", KEY).send(body);
    expect(res.status).toBe(200);
    expect(res.body.people).toHaveLength(5000);
  });

  it("answers a named 413 over the route's limit, never a 500", async () => {
    const big = "x".repeat(6 * 1024 * 1024);
    const res = await request(app)
      .post("/internal/acquisition-costs")
      .set("x-api-key", KEY)
      .set("content-type", "application/json")
      .send(JSON.stringify({ orgId: ORG, servedLeads: [], pad: big }));
    expect(res.status).toBe(413);
    expect(res.body.type).toBe("validation");
    expect(res.body.error).toMatch(/too large/i);
  });

  it("keeps the 100kb default on every other route (named 413)", async () => {
    const res = await request(app)
      .post("/internal/email-verifications")
      .set("content-type", "application/json")
      .send(JSON.stringify({ pad: "x".repeat(200 * 1024) }));
    expect(res.status).toBe(413);
    expect(res.body.type).toBe("validation");
  });
});
