import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Tests for POST /webhook/waterfall — Apollo waterfall enrichment callback.
 *
 * Covers: secret validation, enrichment update, cost tracking, edge cases.
 *
 * Key invariants:
 * - credits_consumed is tracked ONCE per webhook (not per person)
 * - A single waterfall run is created per webhook batch
 * - request_id precision is preserved via rawBody parsing
 */

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockAddCosts = vi.fn().mockResolvedValue({ costs: [] });
const mockUpdateCostStatus = vi.fn().mockResolvedValue({});

vi.mock("../../src/lib/runs-client.js", () => ({
  addCosts: (...args: unknown[]) => mockAddCosts(...args),
  updateCostStatus: (...args: unknown[]) => mockUpdateCostStatus(...args),
}));

const mockDbSelect = vi.fn();
const mockDbUpdate = vi.fn();

vi.mock("../../src/db/index.js", () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
    update: (...args: unknown[]) => mockDbUpdate(...args),
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  apolloPeopleEnrichments: {
    id: { name: "id" },
    waterfallRequestId: { name: "waterfall_request_id" },
    waterfallStatus: { name: "waterfall_status" },
    apolloPersonId: { name: "apollo_person_id" },
    email: { name: "email" },
    emailStatus: { name: "email_status" },
    waterfallSource: { name: "waterfall_source" },
  },
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

const WEBHOOK_SECRET = "test-secret-123";

const PENDING_ENRICHMENT = {
  id: "enrichment-1",
  orgId: "org-123",
  apolloPersonId: "apollo-person-1",
  enrichmentRunId: "enrich-run-1",
  brandIds: ["brand-1"],
  campaignId: "campaign-1",
  featureSlug: "feat-1",
  workflowSlug: "wf-1",
  waterfallRequestId: "req-abc",
  waterfallStatus: "pending",
  keySource: "platform",
  provisionedCostId: "prov-cost-1",
};

function makeWebhookPayload(overrides: Record<string, unknown> = {}) {
  return {
    status: "success",
    request_id: "req-abc",
    credits_consumed: 1,
    total_requested_enrichments: 1,
    records_enriched: 1,
    email_records_enriched: 1,
    email_records_not_found: 0,
    people: [
      {
        id: "apollo-person-1",
        waterfall: {
          emails: [
            {
              vendors: [
                {
                  id: "icypeas-1",
                  name: "Icypeas",
                  status: "VERIFIED",
                  emails: ["found@example.com"],
                },
              ],
            },
          ],
        },
        emails: [{ email: "found@example.com", email_status: "verified" }],
      },
    ],
    ...overrides,
  };
}

function createTestApp() {
  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => {
      (req as any).rawBody = buf.toString();
    },
  }));
  return app;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("POST /webhook/waterfall", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv("APOLLO_WATERFALL_WEBHOOK_SECRET", WEBHOOK_SECRET);

    // Default: select returns the pending enrichment
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([PENDING_ENRICHMENT]),
      }),
    });

    // Default: update returns successfully
    mockDbUpdate.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    app = createTestApp();
    const { default: webhookRoutes } = await import("../../src/routes/webhook.js");
    app.use(webhookRoutes);
  });

  it("rejects requests with wrong secret", async () => {
    const res = await request(app)
      .post("/webhook/waterfall?secret=wrong-secret")
      .send(makeWebhookPayload())
      .expect(401);

    expect(res.body.error).toBe("Invalid webhook secret");
  });

  it("rejects requests with no secret", async () => {
    await request(app)
      .post("/webhook/waterfall")
      .send(makeWebhookPayload())
      .expect(401);
  });

  it("accepts valid webhook and updates enrichment with email", async () => {
    const res = await request(app)
      .post(`/webhook/waterfall?secret=${WEBHOOK_SECRET}`)
      .send(makeWebhookPayload())
      .expect(200);

    expect(res.body.received).toBe(true);
    expect(res.body.updated).toBe(1);

    // Should have updated the enrichment record
    expect(mockDbUpdate).toHaveBeenCalled();
    const setCall = mockDbUpdate.mock.results[0].value.set;
    expect(setCall).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "found@example.com",
        emailStatus: "verified",
        waterfallStatus: "completed",
        waterfallSource: "Icypeas",
      })
    );
  });

  it("cancels provisioned cost and adds actual cost on webhook", async () => {
    await request(app)
      .post(`/webhook/waterfall?secret=${WEBHOOK_SECRET}`)
      .send(makeWebhookPayload())
      .expect(200);

    // Cancel provisioned cost on the original match run
    expect(mockUpdateCostStatus).toHaveBeenCalledTimes(1);
    expect(mockUpdateCostStatus).toHaveBeenCalledWith(
      "enrich-run-1",
      "prov-cost-1",
      "cancelled",
      expect.objectContaining({ orgId: "org-123" })
    );

    // Add actual cost with credits_consumed from payload
    expect(mockAddCosts).toHaveBeenCalledTimes(1);
    expect(mockAddCosts).toHaveBeenCalledWith(
      "enrich-run-1",
      [{ costName: "apollo-credit", costSource: "platform", quantity: 1, status: "actual" }],
      expect.objectContaining({ orgId: "org-123" })
    );
  });

  it("tracks credits_consumed=3 once even with 3 people (regression: no over-count)", async () => {
    const threeEnrichments = [
      { ...PENDING_ENRICHMENT, id: "e-1", apolloPersonId: "p-1" },
      { ...PENDING_ENRICHMENT, id: "e-2", apolloPersonId: "p-2" },
      { ...PENDING_ENRICHMENT, id: "e-3", apolloPersonId: "p-3" },
    ];
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(threeEnrichments),
      }),
    });

    const payload = makeWebhookPayload({
      credits_consumed: 3,
      people: [
        { id: "p-1", emails: [{ email: "a@x.com", email_status: "verified" }], waterfall: { emails: [{ vendors: [{ id: "v", name: "V", status: "ok" }] }] } },
        { id: "p-2", emails: [{ email: "b@x.com", email_status: "verified" }], waterfall: { emails: [{ vendors: [{ id: "v", name: "V", status: "ok" }] }] } },
        { id: "p-3", emails: [{ email: "c@x.com", email_status: "verified" }], waterfall: { emails: [{ vendors: [{ id: "v", name: "V", status: "ok" }] }] } },
      ],
    });

    await request(app)
      .post(`/webhook/waterfall?secret=${WEBHOOK_SECRET}`)
      .send(payload)
      .expect(200);

    // ONE addCosts with quantity=3 (not per-person)
    expect(mockAddCosts).toHaveBeenCalledTimes(1);
    expect(mockAddCosts).toHaveBeenCalledWith(
      "enrich-run-1",
      [{ costName: "apollo-credit", costSource: "platform", quantity: 3, status: "actual" }],
      expect.any(Object)
    );
  });

  it("marks enrichment as failed when no email found", async () => {
    const payload = makeWebhookPayload({
      credits_consumed: 0,
      people: [
        {
          id: "apollo-person-1",
          waterfall: { emails: [] },
          emails: [],
        },
      ],
    });

    const res = await request(app)
      .post(`/webhook/waterfall?secret=${WEBHOOK_SECRET}`)
      .send(payload)
      .expect(200);

    expect(res.body.updated).toBe(1);

    // Should mark as failed, not completed
    const setCall = mockDbUpdate.mock.results[0].value.set;
    expect(setCall).toHaveBeenCalledWith({ waterfallStatus: "failed" });

    // Provisioned cost still cancelled, but no actual cost added (credits_consumed=0)
    expect(mockUpdateCostStatus).toHaveBeenCalledTimes(1);
    expect(mockAddCosts).not.toHaveBeenCalled();
  });

  it("returns 200 with updated=0 when no pending enrichments found", async () => {
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    const res = await request(app)
      .post(`/webhook/waterfall?secret=${WEBHOOK_SECRET}`)
      .send(makeWebhookPayload())
      .expect(200);

    expect(res.body.updated).toBe(0);
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it("handles empty people array gracefully", async () => {
    const res = await request(app)
      .post(`/webhook/waterfall?secret=${WEBHOOK_SECRET}`)
      .send(makeWebhookPayload({ people: [] }))
      .expect(200);

    expect(res.body.updated).toBe(0);
  });

  it("uses org keySource for cost tracking", async () => {
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ ...PENDING_ENRICHMENT, keySource: "org" }]),
      }),
    });

    await request(app)
      .post(`/webhook/waterfall?secret=${WEBHOOK_SECRET}`)
      .send(makeWebhookPayload())
      .expect(200);

    expect(mockAddCosts).toHaveBeenCalledWith(
      "enrich-run-1",
      [{ costName: "apollo-credit", costSource: "org", quantity: 1, status: "actual" }],
      expect.any(Object)
    );
  });
});
