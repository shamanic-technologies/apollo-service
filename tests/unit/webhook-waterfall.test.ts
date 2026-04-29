import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Tests for POST /webhook/waterfall — Apollo waterfall enrichment callback.
 *
 * Covers: secret validation, enrichment update, cost tracking, edge cases.
 */

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockCreateRun = vi.fn().mockResolvedValue({ id: "waterfall-run-1" });
const mockUpdateRun = vi.fn().mockResolvedValue({});
const mockAddCosts = vi.fn().mockResolvedValue({ costs: [] });

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...args: unknown[]) => mockCreateRun(...args),
  updateRun: (...args: unknown[]) => mockUpdateRun(...args),
  addCosts: (...args: unknown[]) => mockAddCosts(...args),
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
  app.use(express.json());
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

  it("creates a waterfall run and tracks costs", async () => {
    await request(app)
      .post(`/webhook/waterfall?secret=${WEBHOOK_SECRET}`)
      .send(makeWebhookPayload())
      .expect(200);

    // Should create a child run under the enrichment run
    expect(mockCreateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-123",
        serviceName: "apollo-service",
        taskName: "waterfall-enrichment",
        parentRunId: "enrich-run-1",
      })
    );

    // Should track waterfall cost
    expect(mockAddCosts).toHaveBeenCalledWith(
      "waterfall-run-1",
      [{ costName: "apollo-waterfall-email-credit", costSource: "platform", quantity: 1 }],
      expect.objectContaining({ orgId: "org-123" })
    );

    // Should complete the waterfall run
    expect(mockUpdateRun).toHaveBeenCalledWith(
      "waterfall-run-1",
      "completed",
      expect.any(Object)
    );
  });

  it("marks enrichment as failed when no email found", async () => {
    const payload = makeWebhookPayload({
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
      expect.any(String),
      [{ costName: "apollo-waterfall-email-credit", costSource: "org", quantity: 1 }],
      expect.any(Object)
    );
  });
});
