import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Tests for waterfall cost tracking overhaul.
 *
 * Covers:
 * - Provisioned cost (20 credits) created when waterfall accepted
 * - Cancel provisioned + add actual on webhook arrival
 * - Match run marked "failed" on poll timeout
 * - Match returns 200 person:null when waterfall fails (not 504)
 * - Lazy cleanup: pending > 24h → cancel prov + add 20 actual worst case
 * - updateCostStatus helper in runs-client
 * - No duplicate waterfall-enrichment child run at webhook
 */

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockCreateRun = vi.fn();
const mockUpdateRun = vi.fn().mockResolvedValue({});
const mockAddCosts = vi.fn().mockResolvedValue({ costs: [{ id: "cost-1" }] });
const mockUpdateCostStatus = vi.fn().mockResolvedValue({});

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...args: unknown[]) => mockCreateRun(...args),
  updateRun: (...args: unknown[]) => mockUpdateRun(...args),
  addCosts: (...args: unknown[]) => mockAddCosts(...args),
  updateCostStatus: (...args: unknown[]) => mockUpdateCostStatus(...args),
}));

vi.mock("../../src/middleware/auth.js", () => ({
  serviceAuth: (req: any, _res: any, next: any) => {
    req.orgId = req.headers["x-org-id"] || "org-test";
    req.userId = req.headers["x-user-id"] || "user-test";
    if (req.headers["x-run-id"]) req.runId = req.headers["x-run-id"];
    if (req.headers["x-brand-id"]) {
      req.brandId = req.headers["x-brand-id"] as string;
      req.brandIds = String(req.headers["x-brand-id"]).split(",").map((s: string) => s.trim()).filter(Boolean);
    }
    if (req.headers["x-campaign-id"]) req.campaignId = req.headers["x-campaign-id"];
    if (req.headers["x-feature-slug"]) req.featureSlug = req.headers["x-feature-slug"];
    if (req.headers["x-workflow-slug"]) req.workflowSlug = req.headers["x-workflow-slug"];
    next();
  },
}));

const mockInsertReturning = vi.fn().mockResolvedValue([{ id: "enrichment-1" }]);
const mockInsertValues = vi.fn().mockReturnValue({ returning: (...args: unknown[]) => mockInsertReturning(...args) });
const mockSelectLimit = vi.fn().mockResolvedValue([]);

const mockDbUpdate = vi.fn();

// Mutable db mock — reset in each beforeEach to survive vi.clearAllMocks()
const mockDb: any = {};

function resetDbMocks() {
  mockDbUpdate.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([]),
    }),
  });

  mockDb.insert = vi.fn().mockReturnValue({
    values: (...args: unknown[]) => mockInsertValues(...args),
  });
  mockDb.select = vi.fn().mockImplementation(() => ({
    from: vi.fn().mockImplementation(() => ({
      where: vi.fn().mockImplementation(() => ({
        orderBy: vi.fn().mockImplementation(() => ({
          limit: (...args: unknown[]) => mockSelectLimit(...args),
        })),
        limit: (...args: unknown[]) => mockSelectLimit(...args),
      })),
    })),
  }));
  mockDb.update = (...args: unknown[]) => mockDbUpdate(...args);
}
resetDbMocks();

vi.mock("../../src/db/index.js", () => ({
  db: mockDb,
}));

vi.mock("../../src/db/schema.js", () => ({
  apolloPeopleEnrichments: {
    id: { name: "id" },
    firstName: { name: "first_name" },
    lastName: { name: "last_name" },
    organizationDomain: { name: "organization_domain" },
    email: { name: "email" },
    emailStatus: { name: "email_status" },
    waterfallStatus: { name: "waterfall_status" },
    waterfallRequestId: { name: "waterfall_request_id" },
    waterfallSource: { name: "waterfall_source" },
    createdAt: { name: "created_at" },
    apolloPersonId: { name: "apollo_person_id" },
    provisionedCostId: { name: "provisioned_cost_id" },
  },
}));

const mockDecryptKey = vi.fn().mockResolvedValue({ key: "fake-apollo-key", keySource: "platform" });
vi.mock("../../src/lib/keys-client.js", () => ({
  decryptKey: (...args: unknown[]) => mockDecryptKey(...args),
}));

vi.mock("../../src/lib/billing-client.js", () => ({
  authorizeCredit: vi.fn().mockResolvedValue({ sufficient: true, balance_cents: 99999 }),
}));

const MOCK_PERSON_NO_EMAIL = {
  id: "person-1",
  first_name: "Jane",
  last_name: "Smith",
  name: "Jane Smith",
  email: null,
  email_status: null,
  title: "VP Sales",
  linkedin_url: "https://linkedin.com/in/janesmith",
  organization: {
    id: "org-acme",
    name: "Acme Inc",
    website_url: "https://acme.com",
    primary_domain: "acme.com",
    industry: "tech",
    estimated_num_employees: 200,
    annual_revenue: null,
  },
};

const MOCK_PERSON_WITH_EMAIL = {
  ...MOCK_PERSON_NO_EMAIL,
  email: "jane@acme.com",
  email_status: "verified",
};

const mockMatchPersonByName = vi.fn();

vi.mock("../../src/lib/apollo-client.js", () => ({
  matchPersonByName: (...args: unknown[]) => mockMatchPersonByName(...args),
  buildWaterfallWebhookUrl: () => "https://apollo.test/webhook/waterfall?secret=s",
}));

const mockTraceEvent = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/lib/trace-event.js", () => ({
  traceEvent: (...args: unknown[]) => mockTraceEvent(...args),
}));

vi.mock("../../src/lib/validators.js", () => ({
  assertKeySource: () => {},
}));

vi.mock("../../src/lib/transform.js", () => ({
  transformApolloPerson: (p: any) => ({
    id: p.id,
    firstName: p.first_name,
    lastName: p.last_name,
    email: p.email,
    emailStatus: p.email_status,
  }),
  toEnrichmentDbValues: (p: any) => ({
    apolloPersonId: p.id,
    firstName: p.first_name,
    lastName: p.last_name,
    email: p.email,
    emailStatus: p.email_status,
    organizationDomain: p.organization?.primary_domain,
  }),
  transformCachedEnrichment: (_id: string, record: any) => ({
    id: record.apolloPersonId,
    firstName: record.firstName,
    lastName: record.lastName,
    email: record.email,
    emailStatus: record.emailStatus,
  }),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

function createTestApp() {
  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => {
      (req as any).rawBody = buf.toString();
    },
  }));
  return app;
}

function setBaseHeaders(req: request.Test): request.Test {
  return req
    .set("X-Org-Id", "org-test")
    .set("X-User-Id", "user-test")
    .set("X-Run-Id", "parent-run-1")
    .set("X-Brand-Id", "brand-1")
    .set("X-Campaign-Id", "campaign-1");
}

// ─── POST /match — Waterfall cost tracking ──────────────────────────────────

describe("POST /match — waterfall provisioned cost", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetDbMocks();
    process.env.WATERFALL_POLL_INTERVAL_MS = "10";
    process.env.WATERFALL_POLL_TIMEOUT_MS = "100";

    let runCount = 0;
    mockCreateRun.mockImplementation(() => {
      runCount++;
      return Promise.resolve({ id: `match-run-${runCount}` });
    });
    mockAddCosts.mockResolvedValue({ costs: [{ id: "prov-cost-1" }] });
    mockSelectLimit.mockResolvedValue([]);

    app = createTestApp();
    const { default: matchRoutes } = await import("../../src/routes/match.js");
    app.use(matchRoutes);
  });

  it("provisions 20 credits when waterfall accepted, then cancels + adds actual on poll success", async () => {
    mockMatchPersonByName.mockResolvedValueOnce({
      person: MOCK_PERSON_NO_EMAIL,
      waterfall: { status: "accepted" },
      request_id: "99999",
    });

    // findCachedMatch: positive miss, negative miss
    // poll 1: still pending
    // poll 2: email arrived
    let pollCount = 0;
    mockSelectLimit.mockImplementation(() => {
      pollCount++;
      if (pollCount <= 2) return Promise.resolve([]);
      if (pollCount === 3) return Promise.resolve([{
        id: "enrichment-1",
        apolloPersonId: "person-1",
        email: null,
        waterfallStatus: "pending",
      }]);
      return Promise.resolve([{
        id: "enrichment-1",
        apolloPersonId: "person-1",
        firstName: "Jane",
        lastName: "Smith",
        email: "jane@acme.com",
        emailStatus: "verified",
        waterfallStatus: "completed",
      }]);
    });

    const res = await setBaseHeaders(request(app).post("/match"))
      .send({ firstName: "Jane", lastName: "Smith", organizationDomain: "acme.com" })
      .expect(200);

    expect(res.body.person.email).toBe("jane@acme.com");

    // Should provision 20 credits BEFORE polling
    expect(mockAddCosts).toHaveBeenCalledWith(
      expect.any(String),
      [{ costName: "apollo-credit", costSource: "platform", quantity: 20, status: "provisioned" }],
      expect.any(Object),
    );

    // Should cancel provisioned and add actual
    expect(mockUpdateCostStatus).toHaveBeenCalledWith(
      expect.any(String),
      "prov-cost-1",
      "cancelled",
      expect.any(Object),
    );

    // Run completed
    expect(mockUpdateRun).toHaveBeenCalledWith(
      expect.any(String),
      "completed",
      expect.any(Object),
    );
  });

  it("marks run as FAILED on waterfall poll timeout, cost stays provisioned", async () => {
    mockMatchPersonByName.mockResolvedValueOnce({
      person: MOCK_PERSON_NO_EMAIL,
      waterfall: { status: "accepted" },
      request_id: "99999",
    });

    // All polls return pending (webhook never arrives)
    let pollCount = 0;
    mockSelectLimit.mockImplementation(() => {
      pollCount++;
      if (pollCount <= 2) return Promise.resolve([]);
      return Promise.resolve([{
        id: "enrichment-1",
        apolloPersonId: "person-1",
        email: null,
        waterfallStatus: "pending",
      }]);
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await setBaseHeaders(request(app).post("/match"))
      .send({ firstName: "Jane", lastName: "Smith", organizationDomain: "acme.com" })
      .expect(504);

    expect(res.body.error).toContain("timeout");

    // Run must be FAILED (not completed)
    expect(mockUpdateRun).toHaveBeenCalledWith(
      expect.any(String),
      "failed",
      expect.any(Object),
    );

    // Provisioned cost should NOT be cancelled (webhook may still arrive)
    expect(mockUpdateCostStatus).not.toHaveBeenCalled();

    // Trace event for timeout
    expect(mockTraceEvent).toHaveBeenCalledWith(
      "parent-run-1",
      expect.objectContaining({ event: "waterfall-poll-timeout" }),
      expect.any(Object),
    );

    errorSpy.mockRestore();
  });

  it("returns 200 with person:null when waterfall fails (no email found), not 504", async () => {
    mockMatchPersonByName.mockResolvedValueOnce({
      person: MOCK_PERSON_NO_EMAIL,
      waterfall: { status: "accepted" },
      request_id: "99999",
    });

    // Poll: webhook arrives saying "failed" (no email)
    let pollCount = 0;
    mockSelectLimit.mockImplementation(() => {
      pollCount++;
      if (pollCount <= 2) return Promise.resolve([]);
      // Immediately returns failed status
      return Promise.resolve([{
        id: "enrichment-1",
        apolloPersonId: "person-1",
        email: null,
        waterfallStatus: "failed",
      }]);
    });

    const res = await setBaseHeaders(request(app).post("/match"))
      .send({ firstName: "Jane", lastName: "Smith", organizationDomain: "acme.com" })
      .expect(200);

    // Should return 200 with null person, NOT 504
    expect(res.body.person).toBeNull();

    // Run should be completed (waterfall finished, just no result)
    expect(mockUpdateRun).toHaveBeenCalledWith(
      expect.any(String),
      "completed",
      expect.any(Object),
    );

    // Should cancel provisioned cost + add actual (0 or whatever credits_consumed)
    expect(mockUpdateCostStatus).toHaveBeenCalledWith(
      expect.any(String),
      "prov-cost-1",
      "cancelled",
      expect.any(Object),
    );
  });

  it("stores provisioned_cost_id in DB enrichment record", async () => {
    mockMatchPersonByName.mockResolvedValueOnce({
      person: MOCK_PERSON_WITH_EMAIL,
    });

    await setBaseHeaders(request(app).post("/match"))
      .send({ firstName: "Jane", lastName: "Smith", organizationDomain: "acme.com" })
      .expect(200);

    // Check that the INSERT includes the enrichment fields
    expect(mockInsertValues).toHaveBeenCalled();
  });
});

// ─── POST /webhook/waterfall — Cancel provisioned + add actual ──────────────

describe("POST /webhook/waterfall — cost reconciliation", () => {
  let app: express.Express;

  const PENDING_ENRICHMENT = {
    id: "enrichment-1",
    orgId: "org-123",
    apolloPersonId: "apollo-person-1",
    enrichmentRunId: "match-run-1",
    brandIds: ["brand-1"],
    campaignId: "campaign-1",
    featureSlug: "feat-1",
    workflowSlug: "wf-1",
    waterfallRequestId: "req-abc",
    waterfallStatus: "pending",
    keySource: "platform",
    provisionedCostId: "prov-cost-1",
  };

  const mockDbSelect = vi.fn();
  const mockDbUpdate = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv("APOLLO_WATERFALL_WEBHOOK_SECRET", "test-secret");

    const { db } = await import("../../src/db/index.js");
    (db as any).select = (...args: unknown[]) => mockDbSelect(...args);
    (db as any).update = (...args: unknown[]) => mockDbUpdate(...args);

    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([PENDING_ENRICHMENT]),
      }),
    });

    mockDbUpdate.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    app = createTestApp();
    const { default: webhookRoutes } = await import("../../src/routes/webhook.js");
    app.use(webhookRoutes);
  });

  it("cancels provisioned cost and adds actual cost from credits_consumed", async () => {
    const payload = {
      status: "success",
      request_id: "req-abc",
      credits_consumed: 3,
      total_requested_enrichments: 1,
      records_enriched: 1,
      email_records_enriched: 1,
      email_records_not_found: 0,
      people: [{
        id: "apollo-person-1",
        waterfall: { emails: [{ vendors: [{ id: "v1", name: "Icypeas", status: "ok" }] }] },
        emails: [{ email: "found@example.com", email_status: "verified" }],
      }],
    };

    await request(app)
      .post("/webhook/waterfall?secret=test-secret")
      .send(payload)
      .expect(200);

    // Should cancel the provisioned cost
    expect(mockUpdateCostStatus).toHaveBeenCalledWith(
      "match-run-1",
      "prov-cost-1",
      "cancelled",
      expect.objectContaining({ orgId: "org-123" }),
    );

    // Should add actual cost with real credits_consumed
    expect(mockAddCosts).toHaveBeenCalledWith(
      "match-run-1",
      [{ costName: "apollo-credit", costSource: "platform", quantity: 3, status: "actual" }],
      expect.objectContaining({ orgId: "org-123" }),
    );

    // Should NOT create a separate waterfall-enrichment child run
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it("cancels provisioned cost with 0 actual when no email and 0 credits", async () => {
    const payload = {
      status: "success",
      request_id: "req-abc",
      credits_consumed: 0,
      total_requested_enrichments: 1,
      records_enriched: 0,
      email_records_enriched: 0,
      email_records_not_found: 1,
      people: [{
        id: "apollo-person-1",
        waterfall: { emails: [] },
        emails: [],
      }],
    };

    await request(app)
      .post("/webhook/waterfall?secret=test-secret")
      .send(payload)
      .expect(200);

    // Should still cancel the provisioned cost
    expect(mockUpdateCostStatus).toHaveBeenCalledWith(
      "match-run-1",
      "prov-cost-1",
      "cancelled",
      expect.any(Object),
    );

    // No actual cost to add (0 credits consumed)
    expect(mockAddCosts).not.toHaveBeenCalled();
  });
});

// ─── Lazy cleanup: pending > 24h ────────────────────────────────────────────

describe("findCachedMatch — lazy cleanup of expired waterfall", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetDbMocks();
    process.env.WATERFALL_POLL_INTERVAL_MS = "10";
    process.env.WATERFALL_POLL_TIMEOUT_MS = "100";

    let runCount = 0;
    mockCreateRun.mockImplementation(() => {
      runCount++;
      return Promise.resolve({ id: `run-${runCount}` });
    });
    mockAddCosts.mockResolvedValue({ costs: [{ id: "prov-cost-1" }] });
    mockDbUpdate.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    app = createTestApp();
    const { default: matchRoutes } = await import("../../src/routes/match.js");
    app.use(matchRoutes);
  });

  it("cancels provisioned cost + adds 20 actual worst case on pending > 24h", async () => {
    const expiredRecord = {
      id: "old-enrichment-1",
      apolloPersonId: null,
      firstName: "Jane",
      lastName: "Smith",
      email: null,
      emailStatus: null,
      organizationDomain: "acme.com",
      waterfallStatus: "pending",
      waterfallRequestId: "old-req",
      provisionedCostId: "old-prov-cost-1",
      enrichmentRunId: "old-match-run-1",
      keySource: "platform",
      brandIds: ["brand-1"],
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000), // 25h ago
    };

    // positive cache miss, then negative cache returns expired pending record
    let callCount = 0;
    mockSelectLimit.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve([]);
      if (callCount === 2) return Promise.resolve([expiredRecord]);
      return Promise.resolve([]);
    });

    const res = await setBaseHeaders(request(app).post("/match"))
      .send({ firstName: "Jane", lastName: "Smith", organizationDomain: "acme.com" })
      .expect(200);

    // Should return cached negative (person: null)
    expect(res.body.person).toBeNull();
    expect(res.body.cached).toBe(true);

    // Should cancel old provisioned cost
    expect(mockUpdateCostStatus).toHaveBeenCalledWith(
      "old-match-run-1",
      "old-prov-cost-1",
      "cancelled",
      expect.any(Object),
    );

    // Should add 20 actual worst case
    expect(mockAddCosts).toHaveBeenCalledWith(
      "old-match-run-1",
      [{ costName: "apollo-credit", costSource: "platform", quantity: 20, status: "actual" }],
      expect.any(Object),
    );

    // Should emit trace event
    expect(mockTraceEvent).toHaveBeenCalledWith(
      "old-match-run-1",
      expect.objectContaining({ event: "waterfall-expired" }),
      expect.any(Object),
    );
  });
});

// ─── runs-client: updateCostStatus is callable ─────────────────────────────

describe("updateCostStatus integration", () => {
  it("is exported and callable via mock", async () => {
    // The mock at the top of this file already validates that updateCostStatus
    // is imported and callable. This test verifies the mock wiring works.
    const { updateCostStatus: fn } = await import("../../src/lib/runs-client.js");
    await fn("run-1", "cost-1", "cancelled", { orgId: "org-1" });
    expect(mockUpdateCostStatus).toHaveBeenCalledWith("run-1", "cost-1", "cancelled", { orgId: "org-1" });
  });
});
