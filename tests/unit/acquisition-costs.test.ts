import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const mockExecute = vi.fn();
vi.mock("../../src/db/index.js", () => ({
  db: { execute: (...args: unknown[]) => mockExecute(...args) },
}));
const mockRunsBatch = vi.fn();
vi.mock("../../src/lib/runs-client.js", () => ({
  getRunCostsBatch: (...args: unknown[]) => mockRunsBatch(...args),
}));

const KEY = "unit-test-apollo-key";
process.env.APOLLO_SERVICE_API_KEY = KEY;

import routes from "../../src/routes/acquisition-costs.js";
import { attributeAcquisitions } from "../../src/lib/acquisition-costs.js";
import type { BatchRunCost } from "../../src/lib/runs-client.js";

const ORG = "308f528f-03ad-44b1-9cbc-623a6af9ba0e";
const OTHER_ORG = "11111111-1111-4111-8111-111111111111";
const SERVING = "a41c4e52-7d37-4910-ac50-ff87ab66ae04";
const EARLIER = "583a4e74-3ed3-4eab-9455-1214c5688e1b";
const R1 = "00000000-0000-4000-8000-000000000001";
const R2 = "00000000-0000-4000-8000-000000000002";
const R3 = "00000000-0000-4000-8000-000000000003";

function run(id: string, campaignId: string | null, startedAt: string, cents: string): BatchRunCost {
  return { id, campaignId, workflowSlug: "wf", startedAt, actualCostInUsdCents: cents };
}

function app() {
  const a = express();
  a.use(express.json());
  a.use(routes);
  return a;
}

describe("attributeAcquisitions", () => {
  const served = { servedCampaignId: SERVING, servedAt: "2026-10-15T00:00:00Z", apolloPersonId: "p1", email: "A@x.com" };

  it("counts a reveal paid by an earlier campaign, once even when matched by id AND email", () => {
    const runs = new Map([[R1, run(R1, EARLIER, "2026-09-29T00:00:00Z", "8.8000000000")]]);
    const out = attributeAcquisitions(ORG, [served], [
      { idx: 0, kind: "apollo_reveal", runId: R1, orgId: ORG },
      { idx: 0, kind: "apollo_reveal", runId: R1, orgId: ORG },
    ], runs);
    expect(out.people[0].earlierAcquisitions).toHaveLength(1);
    expect(out.people[0].email).toBe("a@x.com");
    expect(out.campaigns).toEqual([{ campaignId: SERVING, servedLeads: 1, reusedLeads: 1, earlierAcquisitionCostInUsdCents: "8.8000000000", paidByOtherOrgsCostInUsdCents: "0.0000000000" }]);
  });

  it("a lead the serving campaign bought itself reports 0 reused", () => {
    const runs = new Map([
      [R1, run(R1, SERVING, "2026-10-14T00:00:00Z", "5.6")],
      [R2, run(R2, SERVING, "2026-10-14T00:00:01Z", "3.2")],
    ]);
    const out = attributeAcquisitions(ORG, [served], [
      { idx: 0, kind: "apollo_reveal", runId: R1, orgId: ORG },
      { idx: 0, kind: "email_verification", runId: R2, orgId: ORG },
    ], runs);
    expect(out.campaigns[0]).toMatchObject({ servedLeads: 1, reusedLeads: 0, earlierAcquisitionCostInUsdCents: "0.0000000000" });
  });

  it("ignores an acquisition made AFTER the serve, splits other-org spend, sums exactly", () => {
    const runs = new Map([
      [R1, run(R1, null, "2026-10-01T00:00:00Z", "0.1")],
      [R2, run(R2, EARLIER, "2026-10-16T00:00:00Z", "9")],
      [R3, run(R3, "other-org-campaign", "2026-10-02T00:00:00Z", "0.2")],
    ]);
    const out = attributeAcquisitions(ORG, [served], [
      { idx: 0, kind: "apollo_reveal", runId: R1, orgId: ORG },
      { idx: 0, kind: "email_verification", runId: R2, orgId: ORG },
      { idx: 0, kind: "email_find", runId: R3, orgId: OTHER_ORG },
    ], runs);
    expect(out.people[0].earlierAcquisitions.map((a) => a.runId)).toEqual([R1, R3]);
    expect(out.campaigns[0].earlierAcquisitionCostInUsdCents).toBe("0.3000000000");
    expect(out.campaigns[0].paidByOtherOrgsCostInUsdCents).toBe("0.2000000000");
  });

  it("a paying run runs-service does not return is listed, never priced at 0 silently", () => {
    const out = attributeAcquisitions(ORG, [served], [{ idx: 0, kind: "apollo_reveal", runId: R1, orgId: ORG }], new Map());
    expect(out.unpricedRunIds).toEqual([R1]);
    expect(out.campaigns[0].reusedLeads).toBe(0);
  });
});

describe("POST /internal/acquisition-costs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("401 without the service key", async () => {
    const res = await request(app()).post("/internal/acquisition-costs").send({});
    expect(res.status).toBe(401);
  });

  it("400 when a lead has neither apolloPersonId nor email", async () => {
    const res = await request(app())
      .post("/internal/acquisition-costs")
      .set("x-api-key", KEY)
      .send({ orgId: ORG, servedLeads: [{ servedCampaignId: SERVING, servedAt: "2026-10-15T00:00:00Z" }] });
    expect(res.status).toBe(400);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("prices found acquisitions per paying org and totals per campaign", async () => {
    mockExecute.mockResolvedValue([
      { idx: 0, kind: "apollo_reveal", run_id: R1, org_id: ORG },
      { idx: 1, kind: "apollo_reveal", run_id: R2, org_id: ORG },
    ]);
    mockRunsBatch.mockResolvedValue([run(R1, EARLIER, "2026-09-29T00:00:00Z", "8.8"), run(R2, SERVING, "2026-10-15T00:00:00Z", "5.6")]);
    const res = await request(app())
      .post("/internal/acquisition-costs")
      .set("x-api-key", KEY)
      .send({
        orgId: ORG,
        servedLeads: [
          { ref: "a", servedCampaignId: SERVING, servedAt: "2026-10-15T01:00:00Z", apolloPersonId: "p1" },
          { ref: "b", servedCampaignId: SERVING, servedAt: "2026-10-15T01:00:00Z", email: "b@x.com" },
        ],
      });
    expect(res.status).toBe(200);
    expect(mockRunsBatch).toHaveBeenCalledWith(ORG, [R1, R2]);
    expect(res.body.campaigns).toEqual([
      { campaignId: SERVING, servedLeads: 2, reusedLeads: 1, earlierAcquisitionCostInUsdCents: "8.8000000000", paidByOtherOrgsCostInUsdCents: "0.0000000000" },
    ]);
    expect(res.body.people[0].ref).toBe("a");
  });
});
