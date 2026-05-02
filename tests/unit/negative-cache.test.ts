import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Tests for negative email cache on /match.
 *
 * findCachedMatch makes two sequential db.select() calls:
 *   1. Positive cache (has email, 12-month TTL)
 *   2. Negative cache (no email, 24h TTL with waterfall logic)
 *
 * We use mockReturnValueOnce to control each query independently.
 */

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockCreateRun = vi.fn();
const mockUpdateRun = vi.fn().mockResolvedValue({});
const mockAddCosts = vi.fn().mockResolvedValue({ costs: [] });
const mockUpdateCostStatus = vi.fn().mockResolvedValue({});

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...args: unknown[]) => mockCreateRun(...args),
  updateRun: (...args: unknown[]) => mockUpdateRun(...args),
  addCosts: (...args: unknown[]) => mockAddCosts(...args),
  updateCostStatus: (...args: unknown[]) => mockUpdateCostStatus(...args),
}));

vi.mock("../../src/middleware/auth.js", () => ({
  serviceAuth: (req: any, _res: any, next: any) => {
    req.orgId = req.headers["x-org-id"] || "org-internal-123";
    req.userId = req.headers["x-user-id"] || "user-internal-456";
    if (req.headers["x-run-id"]) req.runId = req.headers["x-run-id"];
    if (req.headers["x-brand-id"]) { req.brandId = req.headers["x-brand-id"] as string; req.brandIds = String(req.headers["x-brand-id"]).split(",").map((s: string) => s.trim()).filter(Boolean); }
    if (req.headers["x-campaign-id"]) req.campaignId = req.headers["x-campaign-id"];
    if (req.headers["x-feature-slug"]) req.featureSlug = req.headers["x-feature-slug"];
    if (req.headers["x-workflow-slug"]) req.workflowSlug = req.headers["x-workflow-slug"];
    next();
  },
}));

const mockInsertReturning = vi.fn().mockResolvedValue([{ id: "record-1" }]);
const mockInsertValues = vi.fn().mockReturnValue({ returning: (...args: unknown[]) => mockInsertReturning(...args) });
const mockSelectLimit = vi.fn().mockResolvedValue([]);

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: (...args: unknown[]) => mockInsertValues(...args),
    }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: (...args: unknown[]) => mockSelectLimit(...args),
          }),
          limit: (...args: unknown[]) => mockSelectLimit(...args),
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
  },
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
    createdAt: { name: "created_at" },
    apolloPersonId: { name: "apollo_person_id" },
  },
}));

const mockDecryptKey = vi.fn().mockResolvedValue({ key: "fake-apollo-key", keySource: "platform" });
vi.mock("../../src/lib/keys-client.js", () => ({
  decryptKey: (...args: unknown[]) => mockDecryptKey(...args),
}));

vi.mock("../../src/lib/billing-client.js", () => ({
  authorizeCredit: vi.fn().mockResolvedValue({ sufficient: true, balance_cents: 99999 }),
}));

const MOCK_PERSON = {
  id: "person-match-1",
  first_name: "John",
  last_name: "Doe",
  name: "John Doe",
  email: "john@acme.com",
  email_status: "verified",
  title: "CTO",
  linkedin_url: "https://linkedin.com/in/johndoe",
  photo_url: "https://img.apollo.io/johndoe.jpg",
  headline: "CTO at Acme",
  seniority: "c_suite",
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

const mockMatchPersonByName = vi.fn().mockResolvedValue({ person: MOCK_PERSON });

vi.mock("../../src/lib/apollo-client.js", () => ({
  matchPersonByName: (...args: unknown[]) => mockMatchPersonByName(...args),
  buildWaterfallWebhookUrl: () => undefined,
}));

function createTestApp() {
  const app = express();
  app.use(express.json());
  return app;
}

function setBaseHeaders(req: request.Test): request.Test {
  return req
    .set("X-Org-Id", "org_test")
    .set("X-User-Id", "user_test")
    .set("X-Run-Id", "run-abc")
    .set("X-Brand-Id", "brand-1")
    .set("X-Campaign-Id", "campaign-1");
}

const NEGATIVE_CACHE_RECORD = {
  id: "neg-1",
  apolloPersonId: null,
  firstName: "John",
  lastName: "Doe",
  email: null,
  emailStatus: null,
  title: null,
  linkedinUrl: null,
  organizationName: null,
  organizationDomain: "acme.com",
  waterfallStatus: null,
  waterfallRequestId: null,
  createdAt: new Date(), // < 24h ago
};

const POSITIVE_CACHE_RECORD = {
  id: "pos-1",
  apolloPersonId: "person-match-1",
  firstName: "John",
  lastName: "Doe",
  email: "john@acme.com",
  emailStatus: "verified",
  title: "CTO",
  linkedinUrl: "https://linkedin.com/in/johndoe",
  organizationName: "Acme Inc",
  organizationDomain: "acme.com",
  waterfallStatus: null,
  waterfallRequestId: null,
  createdAt: new Date(),
};

// ─── POST /match — Negative cache ──────────────────────────────────────────

describe("POST /match — negative cache", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockUpdateRun.mockResolvedValue({});
    mockAddCosts.mockResolvedValue({ costs: [] });
    mockInsertReturning.mockResolvedValue([{ id: "record-1" }]);
    mockMatchPersonByName.mockResolvedValue({ person: MOCK_PERSON });
    mockDecryptKey.mockResolvedValue({ key: "fake-apollo-key", keySource: "platform" });
    mockSelectLimit.mockResolvedValue([]); // default: cache miss

    let callCount = 0;
    mockCreateRun.mockImplementation(() => {
      callCount++;
      return Promise.resolve({ id: `run-${callCount}` });
    });

    app = createTestApp();
    const { default: matchRoutes } = await import("../../src/routes/match.js");
    app.use(matchRoutes);
  });

  it("should return person:null and skip Apollo when negative cache hit (no email, not pending, < 24h)", async () => {
    // Query 1 (positive): miss
    mockSelectLimit.mockResolvedValueOnce([]);
    // Query 2 (negative): hit
    mockSelectLimit.mockResolvedValueOnce([NEGATIVE_CACHE_RECORD]);

    const res = await setBaseHeaders(request(app).post("/match"))
      .send({ firstName: "John", lastName: "Doe", organizationDomain: "acme.com" })
      .expect(200);

    expect(res.body.cached).toBe(true);
    expect(res.body.person).toBeNull();
    expect(mockMatchPersonByName).not.toHaveBeenCalled();
    expect(mockDecryptKey).not.toHaveBeenCalled();
    expect(mockAddCosts).not.toHaveBeenCalled();
  });

  it("should call Apollo when negative cache expired (> 24h)", async () => {
    // Both queries return empty -> cache miss
    mockSelectLimit.mockResolvedValueOnce([]);
    mockSelectLimit.mockResolvedValueOnce([]);

    const res = await setBaseHeaders(request(app).post("/match"))
      .send({ firstName: "John", lastName: "Doe", organizationDomain: "acme.com" })
      .expect(200);

    expect(res.body.cached).toBe(false);
    expect(mockMatchPersonByName).toHaveBeenCalled();
  });

  it("should return positive cache even when negative cache also exists", async () => {
    // Query 1 (positive): hit -> returns early, query 2 never called
    mockSelectLimit.mockResolvedValueOnce([POSITIVE_CACHE_RECORD]);

    const res = await setBaseHeaders(request(app).post("/match"))
      .send({ firstName: "John", lastName: "Doe", organizationDomain: "acme.com" })
      .expect(200);

    expect(res.body.cached).toBe(true);
    expect(res.body.person).not.toBeNull();
    expect(res.body.person.email).toBe("john@acme.com");
    expect(mockMatchPersonByName).not.toHaveBeenCalled();
  });

  it("should return negative cache when waterfall is pending > 24h (webhook never arrived)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const stalePendingRecord = {
      ...NEGATIVE_CACHE_RECORD,
      waterfallStatus: "pending",
      waterfallRequestId: "req-stale",
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000), // 25h ago
      enrichmentRunId: "run-stale",
      provisionedCostId: "prov-stale",
      orgId: "org_test",
      brandIds: ["brand-1"],
      campaignId: "campaign-1",
      keySource: "platform",
    };

    // Query 1 (positive): miss
    mockSelectLimit.mockResolvedValueOnce([]);
    // Query 2 (negative): hit — stale pending matched by the OR branch
    mockSelectLimit.mockResolvedValueOnce([stalePendingRecord]);

    const res = await setBaseHeaders(request(app).post("/match"))
      .send({ firstName: "John", lastName: "Doe", organizationDomain: "acme.com" })
      .expect(200);

    expect(res.body.cached).toBe(true);
    expect(res.body.person).toBeNull();
    expect(mockMatchPersonByName).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("should store a negative cache record when Apollo returns no person", async () => {
    mockMatchPersonByName.mockResolvedValueOnce({ person: null });
    // Cache miss
    mockSelectLimit.mockResolvedValueOnce([]);
    mockSelectLimit.mockResolvedValueOnce([]);

    await setBaseHeaders(request(app).post("/match"))
      .send({ firstName: "John", lastName: "Doe", organizationDomain: "acme.com" })
      .expect(200);

    // db.insert should be called with a record containing firstName/lastName/organizationDomain but no apolloPersonId
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        firstName: "John",
        lastName: "Doe",
        organizationDomain: "acme.com",
      })
    );
  });
});
